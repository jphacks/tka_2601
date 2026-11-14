import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
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
  const settings = fakeAdmin([authenticated(), { data: shop, error: null }, { data: null, error: null }]);
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
    pusher_settings: null,
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

Deno.test("a stop-mode visit from the XIAO reaches device_put_visit with exactly its fields", async () => {
  // firmware/xiao/tests/visit_report_test.c asserts this same body byte for byte.
  const firmwareBody = '{"status":"missed","end_reason":"mode_off","mode":"off","chimed_at":"2026-11-06T00:42:03Z"}';
  const result = { id: "12345678-1234-1234-1234-123456789abc", status: "missed", applied: true };
  const visit = fakeAdmin([authenticated(), { data: result, error: null }]);
  const response = await handleDeviceRequest(request(visitPath, firmwareBody), visit.admin);
  assertEquals([response.status, await response.json()], [200, result]);
  assertEquals(visit.calls[1], {
    name: "device_put_visit",
    args: {
      p_device_id: "device-1",
      p_visit_id: "12345678-1234-1234-1234-123456789abc",
      p_visit: {
        chimed_at: "2026-11-06T00:42:03Z",
        mode: "off",
        status: "missed",
        end_reason: "mode_off",
      },
      p_messages: [],
    },
  });
  // The device sends no messages and no answered_at/ended_at for a visit nobody answered.
  const sent = visit.calls[1].args.p_visit as Record<string, unknown>;
  assertEquals(Object.keys(sent).sort(), ["chimed_at", "end_reason", "mode", "status"]);
});

Deno.test("an unpaired device is told 409 and a bad time is told 400, which the XIAO treats as permanent", async () => {
  for (const [code, status] of [["PT409", 409], ["22007", 400], ["23514", 400]] as const) {
    const visit = fakeAdmin([authenticated(), { data: null, error: { code, message: "rejected" } }]);
    const response = await handleDeviceRequest(
      request(visitPath, '{"status":"missed","end_reason":"mode_off","mode":"off","chimed_at":"x"}'),
      visit.admin,
    );
    assertEquals(response.status, status);
  }
});

Deno.test("settings keep the existing fields when the shop profile cannot be read", async () => {
  for (const transportFailure of [false, true]) {
    const { admin: inner } = fakeAdmin([authenticated(), { data: null, error: null }]);
    const admin: DeviceAdmin = {
      rpc(name, args) {
        if (name !== "device_shop_profile") return inner.rpc(name, args);
        if (transportFailure) throw new Error("shop transport failed");
        return Promise.resolve({ data: null, error: failure });
      },
    };
    const response = await handleDeviceRequest(request("/settings", "", "GET"), admin);
    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals([json.mode, json.shop], ["normal", null]);
  }
});

const pusherConfig = {
  schema_version: 1,
  enabled_pushers: ["p1"],
  assignments: { call_start: "p1", call_end: "p1" },
};
const pusherReport = {
  applied_revision: 0,
  applied_config: pusherConfig,
  apply_error: null,
  runtime_status: "normal",
  capabilities: { schema_versions: [1], pushers: [{ id: "p1", gpio: 7 }, { id: "p2", gpio: 8 }] },
};

Deno.test("settings return the authenticated device snapshot and never hide its read failures", async () => {
  const snapshot = { desired_revision: 1, desired_config: pusherConfig, applied_revision: null };
  const { admin, calls } = fakeAdmin([
    authenticated(), { data: null, error: null }, { data: snapshot, error: null },
  ]);
  const response = await handleDeviceRequest(request("/settings", "", "GET"), admin);
  assertEquals((await response.json()).pusher_settings, snapshot);
  assertEquals(calls[2], { name: "device_get_pusher_settings", args: { p_device_id: "device-1" } });
  const unavailable = fakeAdmin([authenticated(), { data: null, error: null }, { data: null, error: failure }]);
  let caught: unknown;
  try { await handleDeviceRequest(request("/settings", "", "GET"), unavailable.admin); } catch (error) { caught = error; }
  assertStrictEquals(caught, failure);
});

Deno.test("firmware pusher settings exclude large shop and reported fields without a shop query", async () => {
  const snapshot = {
    desired_revision: 1, desired_config: pusherConfig,
    applied_config: { ignored: "x".repeat(8000) }, capabilities: { ignored: "x".repeat(8000) },
    shop: { services: Array(100).fill("large service") }, extra_instructions: "x".repeat(8000),
  };
  const { admin, calls } = fakeAdmin([authenticated(), { data: snapshot, error: null }]);
  const response = await handleDeviceRequest(request("/pusher-settings", "", "GET"), admin);
  const text = await response.text();
  assertEquals(JSON.parse(text), { contract_version: 1, paired: true, pusher_settings: { desired_revision: 1, desired_config: pusherConfig } });
  assertEquals(new TextEncoder().encode(text).length < 512, true);
  assertEquals(calls.map((call) => call.name), ["device_authenticate", "device_get_pusher_settings"]);
  for (const paired of [false, true]) {
    const state = { ...device, household_id: paired ? "household-1" : null };
    const missing = fakeAdmin([{ data: [state], error: null }, ...(paired ? [{ data: null, error: null }] : [])]);
    const absent = await handleDeviceRequest(request("/pusher-settings", "", "GET"), missing.admin);
    assertEquals(await absent.json(), { contract_version: 1, paired, pusher_settings: null });
  }
  const anonymous = fakeAdmin([]);
  assertEquals((await handleDeviceRequest(request("/pusher-settings", "", "GET", false), anonymous.admin)).status, 401);
  const method = fakeAdmin([authenticated()]);
  assertEquals((await handleDeviceRequest(request("/pusher-settings", "{}", "PUT"), method.admin)).status, 405);
});

Deno.test("mode settings return only the mode and contract version, and no mode for an unpaired device", async () => {
  for (const mode of ["normal", "omakase", "away", "off"]) {
    const { admin, calls } = fakeAdmin([{ data: [{ ...device, mode, extra_instructions: "x".repeat(500) }], error: null }]);
    const response = await handleDeviceRequest(request("/mode-settings", "", "GET"), admin);
    const text = await response.text();
    assertEquals(JSON.parse(text), { contract_version: 1, paired: true, mode });
    assertEquals(calls.map((call) => call.name), ["device_authenticate"]);
  }
  const unpaired = fakeAdmin([{ data: [{ ...device, household_id: null }], error: null }]);
  assertEquals(await (await handleDeviceRequest(request("/mode-settings", "", "GET"), unpaired.admin)).json(), {
    contract_version: 1,
    paired: false,
    mode: null,
  });
  assertEquals((await handleDeviceRequest(request("/mode-settings", "", "GET", false), fakeAdmin([]).admin)).status, 401);
  assertEquals((await handleDeviceRequest(request("/mode-settings", "{}", "PUT"), fakeAdmin([authenticated()]).admin)).status, 405);
});

Deno.test("mode status reports use the authenticated identity and accept only the four modes", async () => {
  for (const mode of ["normal", "omakase", "away", "off"]) {
    const result = { applied_mode: mode, applied_mode_at: "2026-11-06T00:00:00Z" };
    const { admin, calls } = fakeAdmin([authenticated(), { data: result, error: null }]);
    const response = await handleDeviceRequest(request("/mode-status", JSON.stringify({ mode })), admin);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), result);
    assertEquals(calls[1], { name: "device_report_mode", args: { p_device_id: "device-1", p_mode: mode } });
  }
});

Deno.test("invalid mode status reports never reach mutation and require device credentials", async () => {
  const invalid: unknown[] = [
    {}, { mode: null }, { mode: "stop" }, { mode: "OFF" }, { mode: "normal " }, { mode: "" }, { mode: 1 },
    { mode: true }, { mode: ["off"] }, { mode: "off", extra: 1 }, { mode: "off", device_id: "other-device" },
    { Mode: "off" }, { applied_mode: "off" },
  ];
  for (const body of invalid) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(request("/mode-status", JSON.stringify(body)), admin);
    assertEquals(response.status, 400);
    assertEquals(calls.map((call) => call.name), ["device_authenticate"]);
  }
  for (const [raw, message] of [["{", "本文が JSON ではありません"], ["[]", "本文はオブジェクトにしてください"]]) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(request("/mode-status", raw), admin);
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: message });
    assertEquals(calls.length, 1);
  }
  const anonymous = fakeAdmin([]);
  assertEquals((await handleDeviceRequest(request("/mode-status", '{"mode":"off"}', "PUT", false), anonymous.admin)).status, 401);
  assertEquals(anonymous.calls.length, 0);
  for (const method of ["GET", "POST"]) {
    const wrongMethod = fakeAdmin([authenticated()]);
    assertEquals((await handleDeviceRequest(request("/mode-status", '{"mode":"off"}', method), wrongMethod.admin)).status, 405);
    assertEquals(wrongMethod.calls.length, 1);
  }
});

Deno.test("mode status database rejections keep their public status and unexpected failures surface", async () => {
  for (const [code, expected] of [["PT409", 409], ["PT404", 404], ["22023", 400]] as const) {
    const failed = fakeAdmin([authenticated(), { data: null, error: { code, message: "mode_report_rejected" } }]);
    const response = await handleDeviceRequest(request("/mode-status", '{"mode":"off"}'), failed.admin);
    assertEquals(response.status, expected);
    assertEquals(await response.json(), { error: "mode_report_rejected" });
  }
  const broken = fakeAdmin([authenticated(), { data: null, error: failure }]);
  await assertRejects(() => handleDeviceRequest(request("/mode-status", '{"mode":"off"}'), broken.admin));
});

Deno.test("pusher reports use the authenticated identity and retain device revision zero", async () => {
  const result = { desired_revision: 0, desired_config: null, ...pusherReport };
  const { admin, calls } = fakeAdmin([authenticated(), { data: result, error: null }]);
  const response = await handleDeviceRequest(request("/pusher-status", JSON.stringify({ ...pusherReport, device_id: "other-device" })), admin);
  assertEquals(await response.json(), result);
  assertEquals(calls[1], {
    name: "device_report_pusher_status",
    args: {
      p_device_id: "device-1", p_applied_revision: 0, p_applied_config: pusherConfig,
      p_apply_error: null, p_runtime_status: "normal", p_capabilities: pusherReport.capabilities,
    },
  });
});

Deno.test("status-only reports and pusher conflicts retain their contract", async () => {
  const status = { ...pusherReport, applied_revision: null, applied_config: null, runtime_status: "manual_check_required", apply_error: "storage_failed" };
  const { admin } = fakeAdmin([authenticated(), { data: status, error: null }]);
  assertEquals((await handleDeviceRequest(request("/pusher-status", JSON.stringify(status)), admin)).status, 200);
  for (const [code, expected] of [["PT409", 409], ["22023", 400]] as const) {
    const failed = fakeAdmin([authenticated(), { data: null, error: { code, message: "pusher_report_conflict" } }]);
    const response = await handleDeviceRequest(request("/pusher-status", JSON.stringify(pusherReport)), failed.admin);
    assertEquals(response.status, expected);
    assertEquals(await response.json(), { error: "pusher_report_conflict" });
  }
});

Deno.test("invalid pusher reports never reach mutation and require device credentials", async () => {
  const invalid: unknown[] = [
    {}, { ...pusherReport, applied_revision: true }, { ...pusherReport, applied_revision: 1.5 },
    { ...pusherReport, applied_revision: -1 }, { ...pusherReport, applied_revision: 4294967296 },
    { ...pusherReport, applied_revision: null }, { ...pusherReport, applied_config: null },
    { ...pusherReport, runtime_status: "ended" }, { ...pusherReport, apply_error: "x".repeat(129) },
    { ...pusherReport, capabilities: [] }, { ...pusherReport, capabilities: { too_large: "x".repeat(4096) } },
    { ...pusherReport, applied_config: { ...pusherConfig, schema_version: 2 } },
    { ...pusherReport, applied_config: { ...pusherConfig, enabled_pushers: ["p3"] } },
    { ...pusherReport, applied_config: { ...pusherConfig, assignments: { call_start: "p1", call_end: "p2" } } },
  ];
  for (const body of invalid) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(request("/pusher-status", JSON.stringify(body)), admin);
    assertEquals(response.status, 400);
    assertEquals(calls.length, 1);
  }
  const unauthenticated = fakeAdmin([]);
  assertEquals((await handleDeviceRequest(request("/pusher-status", JSON.stringify(pusherReport), "PUT", false), unauthenticated.admin)).status, 401);
  const wrongMethod = fakeAdmin([authenticated()]);
  assertEquals((await handleDeviceRequest(request("/pusher-status", "", "GET"), wrongMethod.admin)).status, 405);
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
