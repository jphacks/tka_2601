import { assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1.0.19";
import { type DeviceAdmin, handleDeviceRequest } from "./handler.ts";

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
  const settings = fakeAdmin([authenticated()]);
  const response = await handleDeviceRequest(
    request("/settings", "", "GET"),
    settings.admin,
  );
  assertEquals(await response.json(), {
    paired: true,
    mode: "normal",
    away_leave_at_door: false,
    auto_away: false,
    extra_instructions: "",
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
