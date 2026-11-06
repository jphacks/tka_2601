import { readJsonObject, reservationErrorResponse } from "../_shared/errors.ts";
import type { NewNotification } from "../_shared/notify.ts";
import type { ReservationProvider } from "../_shared/reservation.ts";
import { reservationNotice } from "../_shared/reservation_notice.ts";
import { modeSettingsBody, parseAiReservation, parseDeviceRange, parsePusherStatus, pusherSettingsBody, reservationBody, reservationListBody, settingsBody, visitFields } from "./contract.ts";
import { type DatabaseError, visitErrorResponse } from "./errors.ts";

export type DeviceAdmin = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseError | null }>;
};

const VISIT_PATH = /\/visits\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RESERVATION_ARRIVE_PATH = /\/reservations\/([^/]+)\/arrive$/;
type Device = {
  device_id: string;
  household_id: string | null;
  mode: string;
  away_leave_at_door: boolean;
  auto_away: boolean;
  extra_instructions: string;
};

// 予約を読み書きするときだけ使う
export type DeviceReservationDeps = {
  providerFor(householdId: string): Promise<ReservationProvider>;
  notify(notification: NewNotification): Promise<void>;
  // 来客がこの店のものか。違えば予約に結び付けない
  visitBelongs(householdId: string, visitId: string): Promise<boolean>;
};

export async function handleDeviceRequest(
  req: Request,
  admin: DeviceAdmin,
  reservations?: DeviceReservationDeps,
): Promise<Response> {
  const key = bearerToken(req);
  if (!key) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { data: devices, error: authError } = await admin.rpc(
    "device_authenticate",
    {
      p_key_hash: await sha256Hex(key),
    },
  );
  if (authError) throw authError;
  const device = (devices as Device[] | null)?.[0];
  if (!device) return Response.json({ error: "unauthorized" }, { status: 401 });

  const path = new URL(req.url).pathname;

  if (path.endsWith("/mode-settings")) {
    if (req.method !== "GET") return methodNotAllowed();
    return Response.json(modeSettingsBody(device));
  }

  if (path.endsWith("/pusher-settings")) {
    if (req.method !== "GET") return methodNotAllowed();
    return Response.json(pusherSettingsBody(device, await readPushers(admin, device)));
  }

  if (path.endsWith("/settings") || path.endsWith("/mode")) {
    if (req.method !== "GET") return methodNotAllowed();
    const shop = await readShop(admin, device.household_id);
    return Response.json(settingsBody(device, shop, await readPushers(admin, device)));
  }

  if (path.endsWith("/pusher-status")) {
    if (req.method !== "PUT") return methodNotAllowed();
    const body = await readObject(req);
    if (body instanceof Response) return body;
    let report;
    try {
      report = parsePusherStatus(body);
    } catch (e) {
      return reservationErrorResponse(e);
    }
    const { data, error } = await admin.rpc("device_report_pusher_status", {
      p_device_id: device.device_id,
      ...report,
    });
    if (error) return visitErrorResponse(error);
    return Response.json(data);
  }

  if (path.endsWith("/heartbeat")) {
    if (req.method !== "PUT") return methodNotAllowed();
    const { data, error } = await admin.rpc("device_heartbeat", {
      p_device_id: device.device_id,
    });
    if (error) throw error;
    return Response.json(data);
  }

  const arrivePath = path.match(RESERVATION_ARRIVE_PATH);
  if (arrivePath || path.endsWith("/reservations")) {
    if (!reservations) return Response.json({ error: "not found" }, { status: 404 });
    if (!device.household_id) {
      return Response.json({ error: "この本体はまだグループに結び付いていません" }, { status: 409 });
    }
    try {
      if (arrivePath) {
        if (req.method !== "POST") return methodNotAllowed();
        return await arrive(decodeURIComponent(arrivePath[1]), device.household_id, reservations);
      }
      if (req.method === "GET") {
        const range = parseDeviceRange(new URL(req.url).searchParams);
        const provider = await reservations.providerFor(device.household_id);
        return Response.json(reservationListBody(provider.kind, await provider.list(range)));
      }
      if (req.method !== "POST") return methodNotAllowed();
      return await createPending(req, device.household_id, reservations);
    } catch (e) {
      return reservationErrorResponse(e);
    }
  }

  if (path.endsWith("/state")) {
    if (req.method !== "PUT") return methodNotAllowed();
    const body = await readObject(req);
    if (body instanceof Response) return body;
    if (typeof body.auto_away_active !== "boolean") {
      return Response.json({
        error: "auto_away_active は true か false にしてください",
      }, { status: 400 });
    }
    const { data, error } = await admin.rpc("device_set_state", {
      p_device_id: device.device_id,
      p_auto_away_active: body.auto_away_active,
    });
    if (error) throw error;
    return Response.json(data);
  }

  const visitPath = path.match(VISIT_PATH);
  if (visitPath) {
    if (req.method !== "PUT") return methodNotAllowed();
    const body = await readObject(req);
    if (body instanceof Response) return body;
    const messages = body.messages ?? [];
    if (!Array.isArray(messages)) {
      return Response.json({ error: "messages は配列にしてください" }, {
        status: 400,
      });
    }
    const { data, error } = await admin.rpc("device_put_visit", {
      p_device_id: device.device_id,
      p_visit_id: visitPath[1].toLowerCase(),
      p_visit: visitFields(body),
      p_messages: messages,
    });
    if (error) {
      return visitErrorResponse(error);
    }
    return Response.json(data);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

async function readPushers(admin: DeviceAdmin, device: Device): Promise<unknown> {
  if (!device.household_id) return null;
  const { data, error } = await admin.rpc("device_get_pusher_settings", { p_device_id: device.device_id });
  if (error) throw error;
  return data ?? null;
}

// 店舗の設定。中継は設定を 1.5 秒で読むので Google は呼ばず、読めなければ shop だけを null にする
async function readShop(admin: DeviceAdmin, householdId: string | null): Promise<unknown> {
  if (!householdId) return null;
  try {
    const { data, error } = await admin.rpc("device_shop_profile", {
      p_household_id: householdId,
    });
    if (error) throw error;
    return data ?? null;
  } catch (e) {
    console.warn("shop profile unavailable", e);
    return null;
  }
}

// 仮予約を含む既存の予約と時間が重なれば受け付けない
async function createPending(
  req: Request,
  householdId: string,
  deps: DeviceReservationDeps,
): Promise<Response> {
  const { input, visitId } = parseAiReservation(await readJsonObject(req));
  if (visitId && await deps.visitBelongs(householdId, visitId)) input.visit_id = visitId;
  const provider = await deps.providerFor(householdId);
  const write = await provider.createIfFree(input);
  await deps.notify(
    reservationNotice(householdId, "reservation_pending", write.reservation, write.dedupeKey("reservation_pending")),
  );
  return Response.json(reservationBody(write.reservation), { status: 201 });
}

async function arrive(
  id: string,
  householdId: string,
  deps: DeviceReservationDeps,
): Promise<Response> {
  const provider = await deps.providerFor(householdId);
  const write = await provider.arrive(id);
  await deps.notify(
    reservationNotice(householdId, "reservation_arrived", write.reservation, write.dedupeKey("reservation_arrived")),
  );
  return Response.json(reservationBody(write.reservation));
}

// 本文を JSON のオブジェクトとして読む。だめなら 400 の Response を返す
async function readObject(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "本文が JSON ではありません" }, {
      status: 400,
    });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "本文はオブジェクトにしてください" }, {
      status: 400,
    });
  }
  return body as Record<string, unknown>;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
