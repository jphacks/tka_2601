// アプリが予約を読み書きする入口（docs/reservations.md 3.1）。予約先を問わず同じ形で返す
import type { CalendarStore } from "../_shared/calendar_store.ts";
import { readJsonObject, reservationErrorResponse } from "../_shared/errors.ts";
import type { NewNotification } from "../_shared/notify.ts";
import {
  parseNewReservation,
  parseRange,
  parseReservationPatch,
  type ProviderKind,
  ProviderError,
  type ReservationProvider,
  type ReservationWrite,
} from "../_shared/reservation.ts";
import { type ReservationNoticeKind, reservationNotice } from "../_shared/reservation_notice.ts";
import { completeSquareOAuth, disconnectSquare, handleSquareCallback, handleSquareWebhook, type SquareDeps, startSquareOAuth } from "./square.ts";
import { completeOAuth, disconnect, type GoogleDeps, handleCallback, listCalendars, providerStatus, selectCalendar, startOAuth } from "./google.ts";

export type Member = { userId: string; householdId: string };

export type ReservationsDeps = GoogleDeps & SquareDeps & {
  // null は未ログイン、"forbidden" はグループに入っていない
  authenticate(req: Request): Promise<Member | "forbidden" | null>;
  providerFor(householdId: string): Promise<ReservationProvider>;
  notify(notification: NewNotification): Promise<void>;
};

const PROVIDERS: ProviderKind[] = ["monban", "google_calendar", "square", "hotpepper"];
const methodNotAllowed = () => Response.json({ error: "method not allowed" }, { status: 405 });
const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export async function handleReservationsRequest(req: Request, deps: ReservationsDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^(?:\/functions\/v1)?\/reservations/, "").replace(/\/$/, "");

  try {
    if (path === "/google/callback") {
      return req.method === "GET" ? await handleCallback(deps, url) : methodNotAllowed();
    }
    if (path === "/square/callback") {
      return req.method === "GET" ? await handleSquareCallback(deps, url) : methodNotAllowed();
    }
    // Square が呼ぶ。JWT はなく、署名で確かめる
    if (path === "/square/webhook") {
      return req.method === "POST" ? await handleSquareWebhook(deps, req) : methodNotAllowed();
    }

    const member = await deps.authenticate(req);
    if (member === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (member === "forbidden") return Response.json({ error: "グループに入っていません" }, { status: 403 });

    if (path === "/provider") return await providerRoute(req, deps, member);
    if (path === "/google/start") {
      if (req.method !== "POST") return methodNotAllowed();
      const body = await readJsonObject(req);
      return Response.json({ url: await startOAuth(deps, member.householdId, member.userId, body.return_url) });
    }
    if (path === "/google/complete") {
      if (req.method !== "POST") return methodNotAllowed();
      const body = await readJsonObject(req);
      await completeOAuth(deps, member, body.code);
      return Response.json(await providerStatus(deps.store, member.householdId));
    }
    if (path === "/google/calendars") {
      if (req.method !== "GET") return methodNotAllowed();
      return Response.json({ calendars: await listCalendars(deps, member.householdId) });
    }
    if (path === "/google/calendar") {
      if (req.method !== "PUT") return methodNotAllowed();
      const body = await readJsonObject(req);
      await selectCalendar(deps, member.householdId, body.calendar_id);
      return Response.json(await providerStatus(deps.store, member.householdId));
    }
    if (path === "/google") {
      if (req.method !== "DELETE") return methodNotAllowed();
      await disconnect(deps, member.householdId);
      return Response.json(await providerStatus(deps.store, member.householdId));
    }
    if (path === "/square/start") {
      if (req.method !== "POST") return methodNotAllowed();
      const body = await readJsonObject(req);
      return Response.json({ url: await startSquareOAuth(deps, member.householdId, member.userId, body.return_url) });
    }
    if (path === "/square/complete") {
      if (req.method !== "POST") return methodNotAllowed();
      const body = await readJsonObject(req);
      await completeSquareOAuth(deps, member, body.code);
      return Response.json(await providerStatus(deps.store, member.householdId));
    }
    if (path === "/square") {
      if (req.method !== "DELETE") return methodNotAllowed();
      await disconnectSquare(deps, member.householdId);
      return Response.json(await providerStatus(deps.store, member.householdId));
    }

    if (path === "") return await collectionRoute(req, url, deps, member);
    const action = path.match(/^\/([^/]+)\/(approve|cancel|arrive)$/);
    if (action) {
      if (req.method !== "POST") return methodNotAllowed();
      return await actionRoute(decodeURIComponent(action[1]), action[2] as Action, deps, member);
    }
    const item = path.match(/^\/([^/]+)$/);
    if (item) return await itemRoute(req, decodeURIComponent(item[1]), deps, member);
    return notFound();
  } catch (e) {
    return reservationErrorResponse(e);
  }
}

async function providerRoute(req: Request, deps: ReservationsDeps, member: Member): Promise<Response> {
  if (req.method === "GET") return Response.json(await providerStatus(deps.store, member.householdId));
  if (req.method !== "PUT") return methodNotAllowed();
  const body = await readJsonObject(req);
  const provider = body.provider as ProviderKind;
  if (!PROVIDERS.includes(provider)) throw new ProviderError(400, "provider は monban、google_calendar、square、hotpepper のどれかにしてください");
  if (provider === "google_calendar") {
    const connection = await deps.store.getConnection(member.householdId);
    if (!connection?.calendar_id) throw new ProviderError(409, "Google カレンダーの接続が済んでいません", "google_not_connected");
  }
  if (provider === "square" && !(await deps.store.getSquareConnection(member.householdId))) {
    throw new ProviderError(409, "Square の接続が済んでいません", "square_not_connected");
  }
  await deps.store.setProviderKind(member.householdId, provider);
  return Response.json(await providerStatus(deps.store, member.householdId));
}

async function collectionRoute(req: Request, url: URL, deps: ReservationsDeps, member: Member): Promise<Response> {
  if (req.method === "GET") {
    const range = parseRange(url.searchParams);
    const provider = await deps.providerFor(member.householdId);
    return Response.json({ provider: provider.kind, reservations: await provider.list(range) });
  }
  if (req.method !== "POST") return methodNotAllowed();
  const input = parseNewReservation(await readJsonObject(req), { status: "confirmed", source: "app" });
  const provider = await deps.providerFor(member.householdId);
  return await respondWrite(await provider.create(input), "reservation_created", deps, member, 201);
}

async function itemRoute(req: Request, id: string, deps: ReservationsDeps, member: Member): Promise<Response> {
  const provider = await deps.providerFor(member.householdId);
  if (req.method === "GET") {
    const reservation = await provider.get(id);
    return reservation ? Response.json({ reservation }) : Response.json({ error: "予約が見つかりません" }, { status: 404 });
  }
  if (req.method !== "PATCH") return methodNotAllowed();
  const patch = parseReservationPatch(await readJsonObject(req));
  return await respondWrite(await provider.update(id, patch), "reservation_updated", deps, member);
}

type Action = "approve" | "cancel" | "arrive";

async function actionRoute(id: string, action: Action, deps: ReservationsDeps, member: Member): Promise<Response> {
  const provider = await deps.providerFor(member.householdId);
  if (action === "approve") {
    return await respondWrite(await provider.approve(id), "reservation_updated", deps, member, 200, "予約を確定しました");
  }
  if (action === "cancel") return await respondWrite(await provider.cancel(id), "reservation_cancelled", deps, member);
  return await respondWrite(await provider.arrive(id), "reservation_arrived", deps, member);
}

// 通知は操作した本人を除いて送る
async function respondWrite(
  write: ReservationWrite,
  kind: ReservationNoticeKind,
  deps: ReservationsDeps,
  member: Member,
  status = 200,
  title?: string,
): Promise<Response> {
  await deps.notify(
    reservationNotice(member.householdId, kind, write.reservation, write.dedupeKey(kind), { title, actorUserId: member.userId }),
  );
  return Response.json({ reservation: write.reservation }, { status });
}
