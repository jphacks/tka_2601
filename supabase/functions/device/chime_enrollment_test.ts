import { assertEquals, assertRejects } from "@std/assert";
import { type DeviceAdmin, handleDeviceRequest } from "./handler.ts";

const device = {
  device_id: "device-1",
  household_id: "household-1",
  mode: "normal",
  away_leave_at_door: false,
  auto_away: false,
  extra_instructions: "",
};
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

const chimeRow = {
  request_seq: 3,
  action: "start",
  requested_at: "2026-11-09T00:00:00Z",
  handled_seq: 2,
  phase: "done",
  reason: null,
  registered: true,
  reported_at: "2026-11-09T00:00:01Z",
};

Deno.test("chime enrollment returns only the desired side, and an empty request for no row or an unpaired device", async () => {
  const { admin, calls } = fakeAdmin([authenticated(), { data: chimeRow, error: null }]);
  const response = await handleDeviceRequest(request("/chime-enrollment", "", "GET"), admin);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { contract_version: 1, paired: true, request_seq: 3, action: "start" });
  assertEquals(calls[1], { name: "device_get_chime_enrollment", args: { p_device_id: "device-1" } });
  // 設定の読み取り（device_shop_profile など）は走らない。/settings の末尾判定より前で解決される
  assertEquals(calls.map((call) => call.name), ["device_authenticate", "device_get_chime_enrollment"]);

  const cancel = fakeAdmin([authenticated(), { data: { ...chimeRow, action: "cancel" }, error: null }]);
  assertEquals((await (await handleDeviceRequest(request("/chime-enrollment", "", "GET"), cancel.admin)).json()).action, "cancel");

  const none = fakeAdmin([authenticated(), { data: null, error: null }]);
  assertEquals(await (await handleDeviceRequest(request("/chime-enrollment", "", "GET"), none.admin)).json(), {
    contract_version: 1,
    paired: true,
    request_seq: 0,
    action: null,
  });

  // 未ペアはデータベースを読まない（mode-settings と同じ）
  const unpaired = fakeAdmin([{ data: [{ ...device, household_id: null }], error: null }]);
  assertEquals(await (await handleDeviceRequest(request("/chime-enrollment", "", "GET"), unpaired.admin)).json(), {
    contract_version: 1,
    paired: false,
    request_seq: 0,
    action: null,
  });
  assertEquals(unpaired.calls.map((call) => call.name), ["device_authenticate"]);
});

Deno.test("chime enrollment reads need a device key, allow only GET, and surface unexpected failures", async () => {
  const anonymous = fakeAdmin([]);
  assertEquals((await handleDeviceRequest(request("/chime-enrollment", "", "GET", false), anonymous.admin)).status, 401);
  assertEquals(anonymous.calls.length, 0);
  const unknownKey = fakeAdmin([{ data: [], error: null }]);
  assertEquals((await handleDeviceRequest(request("/chime-enrollment", "", "GET"), unknownKey.admin)).status, 401);
  for (const method of ["PUT", "POST"]) {
    const wrong = fakeAdmin([authenticated()]);
    assertEquals((await handleDeviceRequest(request("/chime-enrollment", "{}", method), wrong.admin)).status, 405);
    assertEquals(wrong.calls.length, 1);
  }
  const broken = fakeAdmin([authenticated(), { data: null, error: failure }]);
  await assertRejects(() => handleDeviceRequest(request("/chime-enrollment", "", "GET"), broken.admin));
});

const chimeReport = { handled_seq: 3, phase: "listen", reason: null, registered: false };

Deno.test("chime status reports use the authenticated identity and pass all four fields", async () => {
  const result = { ...chimeRow, handled_seq: 3, phase: "listen", registered: false };
  const { admin, calls } = fakeAdmin([authenticated(), { data: result, error: null }]);
  const response = await handleDeviceRequest(
    request("/chime-enrollment-status", JSON.stringify(chimeReport)),
    admin,
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), result);
  assertEquals(calls[1], {
    name: "device_report_chime_enrollment",
    args: { p_device_id: "device-1", p_handled_seq: 3, p_phase: "listen", p_reason: null, p_registered: false },
  });
});

Deno.test("chime status accepts every phase, every failure reason, and the sequence bounds", async () => {
  for (const phase of ["idle", "noise", "listen", "analyze", "saving", "done", "failed", "cancelled"]) {
    const { admin, calls } = fakeAdmin([authenticated(), { data: {}, error: null }]);
    const body = { handled_seq: 0, phase, reason: null, registered: true };
    assertEquals((await handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(body)), admin)).status, 200);
    assertEquals(calls[1].args.p_phase, phase);
  }
  for (const reason of ["too_noisy", "too_short", "clipped", "no_recording", "unstable", "background_matches", "busy"]) {
    const { admin, calls } = fakeAdmin([authenticated(), { data: {}, error: null }]);
    const body = { handled_seq: 4294967295, phase: "failed", reason, registered: false };
    assertEquals((await handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(body)), admin)).status, 200);
    assertEquals(calls[1].args.p_reason, reason);
  }
});

Deno.test("invalid chime status reports never reach mutation", async () => {
  const valid = chimeReport;
  const invalid: unknown[] = [
    {},
    { handled_seq: 1, phase: "done", registered: true },
    { handled_seq: 1, phase: "done", reason: null },
    { phase: "done", reason: null, registered: true },
    { ...valid, extra: 1 },
    { ...valid, device_id: "other-device" },
    { ...valid, request_seq: 9 },
    { ...valid, handled_seq: "3" },
    { ...valid, handled_seq: 3.5 },
    { ...valid, handled_seq: -1 },
    { ...valid, handled_seq: 4294967296 },
    { ...valid, handled_seq: null },
    { ...valid, handled_seq: true },
    { ...valid, phase: "running" },
    { ...valid, phase: "Done" },
    { ...valid, phase: "done " },
    { ...valid, phase: null },
    { ...valid, phase: 1 },
    { ...valid, reason: "busy" },
    { ...valid, phase: "done", reason: "too_noisy" },
    { ...valid, phase: "failed", reason: "broken" },
    { ...valid, phase: "failed", reason: "BUSY" },
    { ...valid, phase: "failed", reason: "" },
    { ...valid, phase: "failed", reason: 1 },
    { ...valid, registered: null },
    { ...valid, registered: "true" },
    { ...valid, registered: 1 },
    { Handled_Seq: 3, phase: "listen", reason: null, registered: false },
  ];
  for (const body of invalid) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(body)), admin);
    assertEquals(response.status, 400, JSON.stringify(body));
    assertEquals(calls.map((call) => call.name), ["device_authenticate"], JSON.stringify(body));
  }
  for (const [raw, message] of [["{", "本文が JSON ではありません"], ["[]", "本文はオブジェクトにしてください"]]) {
    const { admin, calls } = fakeAdmin([authenticated()]);
    const response = await handleDeviceRequest(request("/chime-enrollment-status", raw), admin);
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: message });
    assertEquals(calls.length, 1);
  }
  const anonymous = fakeAdmin([]);
  assertEquals(
    (await handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(valid), "PUT", false), anonymous.admin)).status,
    401,
  );
  assertEquals(anonymous.calls.length, 0);
  for (const method of ["GET", "POST"]) {
    const wrong = fakeAdmin([authenticated()]);
    assertEquals(
      (await handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(valid), method), wrong.admin)).status,
      405,
    );
    assertEquals(wrong.calls.length, 1);
  }
});

Deno.test("chime status database rejections keep their public status and unexpected failures surface", async () => {
  for (const [code, expected] of [["PT409", 409], ["PT404", 404], ["22023", 400]] as const) {
    const failed = fakeAdmin([authenticated(), { data: null, error: { code, message: "chime_report_rejected" } }]);
    const response = await handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(chimeReport)), failed.admin);
    assertEquals(response.status, expected);
    assertEquals(await response.json(), { error: "chime_report_rejected" });
  }
  const broken = fakeAdmin([authenticated(), { data: null, error: failure }]);
  await assertRejects(() => handleDeviceRequest(request("/chime-enrollment-status", JSON.stringify(chimeReport)), broken.admin));
});
