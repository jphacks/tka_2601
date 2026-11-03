import { assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1.0.19";
import type { NewNotification } from "../_shared/notify.ts";
import { ProviderError, type Reservation, type ReservationProvider } from "../_shared/reservation.ts";
import { type DeviceAdmin, type DeviceReservationDeps, handleDeviceRequest } from "./handler.ts";

const device = {
  device_id: "device-1",
  household_id: "household-1",
  mode: "normal",
  away_leave_at_door: false,
  auto_away: false,
  extra_instructions: "",
};
const visitPath = "/visits/12345678-1234-1234-1234-123456789abc";
const failure = { code: "XX000", message: "database unavailable" };

function request(path: string, body = "{}", method = "PUT", authorized = true) {
  return new Request(`https://example.test/functions/v1/device${path}`, {
    method,
    headers: authorized ? { authorization: "Bearer device-key" } : {},
    ...(method === "GET" ? {} : { body }),
  });
}

type RpcReply = { data: unknown; error: typeof failure | null };

function fakeAdmin(replies: RpcReply[]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const admin: DeviceAdmin = {
    rpc(name, args) {
      calls.push({ name, args });
      const reply = replies.shift();
      if (!reply) throw new Error(`Unexpected RPC: ${name}`);
      return Promise.resolve(reply);
    },
  };
  return { admin, calls };
}
const authenticated = () => ({ data: [device], error: null });

Deno.test("missing or rejected device credentials return 401 without calling later RPCs", async () => {
  for (const authorized of [false, true]) {
    const { admin, calls } = fakeAdmin([{ data: [], error: null }]);
    const response = await handleDeviceRequest(
      request("/settings", "", "GET", authorized),
      admin,
    );
    assertEquals(response.status, 401);
    assertEquals(await response.json(), { error: "unauthorized" });
    assertEquals(calls.length, authorized ? 1 : 0);
  }
});

Deno.test("device malformed bodies and invalid fields return existing 400 messages before mutation", async () => {
  const cases = [
    [visitPath, "{", "本文が JSON ではありません"],
    [visitPath, "null", "本文はオブジェクトにしてください"],
    [visitPath, "[]", "本文はオブジェクトにしてください"],
    [visitPath, '"text"', "本文はオブジェクトにしてください"],
    [visitPath, '{"messages":{}}', "messages は配列にしてください"],
    [
      "/state",
      '{"auto_away_active":"true"}',
      "auto_away_active は true か false にしてください",
    ],
  ];
  for (const [path, body, message] of cases) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(request(path, body), admin);
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: message });
    assertEquals(calls.map((call) => call.name), ["device_authenticate"]);
  }
});

Deno.test("visit SQL failures retain their exact public status and payload", async () => {
  const cases: [string, number][] = [
    ["42501", 403],
    ["PT409", 409],
    ["22023", 400],
    ["22P02", 400],
    ["22007", 400],
    ["22008", 400],
    ["23502", 400],
    ["23503", 400],
    ["23514", 400],
  ];
  for (const [code, status] of cases) {
    const error = { code, message: `Failure ${code}` };
    const { admin } = fakeAdmin([authenticated(), { data: null, error }]);
    const response = await handleDeviceRequest(request(visitPath), admin);
    assertEquals(response.status, status);
    assertEquals(await response.json(), { error: error.message });
  }
});

Deno.test("unknown visit errors and all auth/state RPC errors preserve the original exception", async () => {
  for (const path of ["/settings", "/state", visitPath]) {
    const replies: RpcReply[] = path === "/settings" ? [] : [authenticated()];
    replies.push({ data: null, error: failure });
    const { admin } = fakeAdmin(replies);
    let caught: unknown;
    try {
      await handleDeviceRequest(
        request(path, '{"auto_away_active":true}'),
        admin,
      );
    } catch (error) {
      caught = error;
    }
    assertStrictEquals(caught, failure);
  }
});

Deno.test("transport rejection is not converted into an input error", async () => {
  const error = new TypeError("network unavailable");
  const admin: DeviceAdmin = { rpc: () => Promise.reject(error) };
  const caught = await assertRejects(
    () => handleDeviceRequest(request(visitPath), admin),
    TypeError,
  );
  assertStrictEquals(caught, error);
});

Deno.test("unsupported methods and routes retain 405 and 404 after authentication", async () => {
  for (
    const [path, method, status, message] of [
      ["/settings", "PUT", 405, "method not allowed"],
      ["/state", "GET", 405, "method not allowed"],
      [visitPath, "GET", 405, "method not allowed"],
      ["/missing", "GET", 404, "not found"],
    ] as const
  ) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(
      request(path, "{}", method),
      admin,
    );
    assertEquals(response.status, status);
    assertEquals(await response.json(), { error: message });
    assertEquals(calls.length, 1);
  }
});

Deno.test("successful settings and visit requests retain response and RPC payload", async () => {
  const shop = { name: "テストのネイルサロン", tone: "very_polite", services: [] };
  const settings = fakeAdmin([authenticated(), { data: shop, error: null }]);
  const response = await handleDeviceRequest(
    request("/settings", "", "GET"),
    settings.admin,
  );
  assertEquals(await response.json(), {
    contract_version: 1,
    paired: true,
    mode: "normal",
    away_leave_at_door: false,
    auto_away: false,
    extra_instructions: "",
    shop,
  });
  assertEquals(settings.calls[1], {
    name: "device_shop_profile",
    args: { p_household_id: "household-1" },
  });
  const result = { id: "visit-1", status: "ended", applied: true };
  const visit = fakeAdmin([authenticated(), { data: result, error: null }]);
  const saved = await handleDeviceRequest(
    request(
      visitPath.toUpperCase().replace("/VISITS/", "/visits/"),
      '{"status":"ended","messages":null,"ignored":"value"}',
    ),
    visit.admin,
  );
  assertEquals(await saved.json(), result);
  assertEquals(visit.calls[1], {
    name: "device_put_visit",
    args: {
      p_device_id: "device-1",
      p_visit_id: "12345678-1234-1234-1234-123456789abc",
      p_visit: { status: "ended" },
      p_messages: [],
    },
  });
});

Deno.test("settings keep the existing fields when the shop profile cannot be read", async () => {
  const replies = [
    [authenticated(), { data: null, error: failure }],
    // 応答を用意しないと fake は投げる（通信の失敗の代わり）
    [authenticated()],
  ];
  for (const reply of replies) {
    const { admin } = fakeAdmin(reply);
    const response = await handleDeviceRequest(request("/settings", "", "GET"), admin);
    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals([json.mode, json.shop], ["normal", null]);
  }
});

Deno.test("unpaired devices read settings without a shop and cannot use reservations", async () => {
  const unpaired = { ...device, household_id: null };
  const { admin, calls } = fakeAdmin([{ data: [unpaired], error: null }]);
  const response = await handleDeviceRequest(request("/settings", "", "GET"), admin);
  assertEquals(((await response.json()) as { paired: boolean }).paired, false);
  assertEquals(calls.length, 1);

  const { deps } = reservationDeps();
  const second = fakeAdmin([{ data: [unpaired], error: null }]);
  const blocked = await handleDeviceRequest(request(`/reservations${range}`, "", "GET"), second.admin, deps);
  assertEquals(blocked.status, 409);
});

Deno.test("heartbeat writes the device state", async () => {
  const reply = { last_heartbeat_at: "2026-11-02T00:00:00Z" };
  const { admin, calls } = fakeAdmin([authenticated(), { data: reply, error: null }]);
  const response = await handleDeviceRequest(request("/heartbeat"), admin);
  assertEquals(await response.json(), reply);
  assertEquals(calls[1], { name: "device_heartbeat", args: { p_device_id: "device-1" } });

  const wrong = fakeAdmin([authenticated()]);
  assertEquals((await handleDeviceRequest(request("/heartbeat", "", "GET"), wrong.admin)).status, 405);
});

const range = "?from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z";
const reservation: Reservation = {
  id: "r1",
  customer_name: "田中",
  customer_phone: null,
  service_name: null,
  starts_at: "2026-11-02T05:00:00.000Z",
  ends_at: "2026-11-02T06:00:00.000Z",
  status: "pending",
  source: "ai",
  note: null,
  arrived_at: null,
  visit_id: null,
  read_only: false,
};
const booking = JSON.stringify({
  customer_name: "田中",
  starts_at: "2026-11-02T14:00:00+09:00",
  ends_at: "2026-11-02T15:00:00+09:00",
  status: "confirmed",
  visit_id: "visit-1",
});

function reservationDeps(existing: Reservation[] = [], visitOk = true) {
  const sent: NewNotification[] = [];
  const created: unknown[] = [];
  const ranges: unknown[] = [];
  const write = { reservation, dedupeKey: (kind: string) => `v1:${kind}` };
  const provider = {
    kind: "monban",
    list(r: unknown) {
      ranges.push(r);
      return Promise.resolve(existing);
    },
    createIfFree(input: unknown) {
      if (existing.length > 0) return Promise.reject(new ProviderError(409, "その時間にはすでに予約があります", "reservation_overlap"));
      created.push(input);
      return Promise.resolve(write);
    },
    arrive: () => Promise.resolve(write),
  } as unknown as ReservationProvider;
  const deps: DeviceReservationDeps = {
    providerFor: () => Promise.resolve(provider),
    notify(notification) {
      sent.push(notification);
      return Promise.resolve();
    },
    visitBelongs: () => Promise.resolve(visitOk),
  };
  return { deps, sent, created, ranges };
}

Deno.test("reservations are listed through the provider", async () => {
  const withContact = { ...reservation, customer_phone: "090-0000-0000", note: "外部の人が書いた文" };
  const { deps } = reservationDeps([withContact]);
  const { admin } = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(request(`/reservations${range}`, "", "GET"), admin, deps);
  const { customer_phone: _phone, note: _note, ...visible } = reservation;
  // 電話番号とメモは本体の鍵では読めない
  assertEquals(await response.json(), { provider: "monban", reservations: [visible] });

  const bad = fakeAdmin([authenticated()]);
  assertEquals((await handleDeviceRequest(request("/reservations", "", "GET"), bad.admin, deps)).status, 400);
});

Deno.test("the device can read at most 31 days at once", async () => {
  const { deps, ranges } = reservationDeps();
  const allowed = fakeAdmin([authenticated()]);
  const ok = await handleDeviceRequest(
    request("/reservations?from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:00Z", "", "GET"),
    allowed.admin,
    deps,
  );
  assertEquals(ok.status, 200);
  const denied = fakeAdmin([authenticated()]);
  const tooLong = await handleDeviceRequest(
    request("/reservations?from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:01Z", "", "GET"),
    denied.admin,
    deps,
  );
  assertEquals(tooLong.status, 400);
  assertEquals(ranges.length, 1);
});

Deno.test("a malformed percent in the reservation id returns 400", async () => {
  const { deps } = reservationDeps();
  const { admin } = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(request("/reservations/%E0%A4%A/arrive", "", "POST"), admin, deps);
  assertEquals(response.status, 400);
});

Deno.test("reservation times without an offset are rejected", async () => {
  const { deps, created } = reservationDeps();
  const { admin } = fakeAdmin([authenticated()]);
  const body = JSON.stringify({ customer_name: "田中", starts_at: "2026-11-05T14:00:00", ends_at: "2026-11-05T15:00:00" });
  const response = await handleDeviceRequest(request("/reservations", body, "POST"), admin, deps);
  assertEquals(response.status, 400);
  assertEquals(created.length, 0);
});

Deno.test("AI reservations are always pending and notify the shop", async () => {
  const { deps, sent, created } = reservationDeps();
  const { admin } = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(request("/reservations", booking, "POST"), admin, deps);
  assertEquals(response.status, 201);
  const input = created[0] as { status: string; source: string; visit_id: string };
  assertEquals([input.status, input.source, input.visit_id], ["pending", "ai", "visit-1"]);
  assertEquals(sent.map((n) => [n.kind, n.actor_user_id, n.dedupe_key]), [["reservation_pending", null, "v1:reservation_pending"]]);
});

Deno.test("AI reservations that overlap an existing one return 409 without writing", async () => {
  const { deps, sent, created } = reservationDeps([reservation]);
  const { admin } = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(request("/reservations", booking, "POST"), admin, deps);
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, "reservation_overlap");
  assertEquals([created.length, sent.length], [0, 0]);
});

Deno.test("a visit from another shop is not linked but the reservation is still taken", async () => {
  const { deps, created } = reservationDeps([], false);
  const { admin } = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(request("/reservations", booking, "POST"), admin, deps);
  assertEquals(response.status, 201);
  assertEquals((created[0] as { visit_id: null }).visit_id, null);
});

Deno.test("arrival is recorded and notified", async () => {
  const { deps, sent } = reservationDeps();
  const { admin } = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(request("/reservations/r1/arrive", "", "POST"), admin, deps);
  assertEquals(response.status, 200);
  assertEquals(sent[0].kind, "reservation_arrived");

  const wrong = fakeAdmin([authenticated()]);
  assertEquals((await handleDeviceRequest(request("/reservations/r1/arrive", "", "GET"), wrong.admin, deps)).status, 405);
});
