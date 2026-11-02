// deno test --allow-env supabase/functions/account/
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { baseConnection, memoryStore } from "../_shared/testing.ts";
import type { SquareConnection } from "../_shared/square.ts";
import { type AccountDeps, handleAccountRequest } from "./handler.ts";

const square: SquareConnection = {
  household_id: "h1",
  merchant_id: "m1",
  merchant_name: "店",
  access_token_encrypted: "unused",
  refresh_token_encrypted: "unused",
  access_token_expires_at: "2026-12-01T00:00:00Z",
  status: "active",
  last_error: null,
  connected_by: "u1",
};

function setup(
  options: {
    household?: string | null;
    members?: number;
    user?: string | null;
    connection?: typeof baseConnection | null;
    square?: SquareConnection | null;
    failDeleteUser?: boolean;
    failDisconnect?: boolean;
  } = {},
) {
  const { store, state } = memoryStore({ connection: options.connection, square: options.square, provider: "google_calendar" });
  const calls: string[] = [];
  if (options.failDisconnect) store.deleteConnection = () => Promise.reject(new Error("db down"));
  const deps: AccountDeps = {
    authenticate: () => Promise.resolve(options.user === undefined ? "u1" : options.user),
    householdOf: () => Promise.resolve(options.household === undefined ? "h1" : options.household),
    memberCount: () => Promise.resolve(options.members ?? 1),
    deleteHousehold: (id) => {
      calls.push(`deleteHousehold:${id}`);
      return Promise.resolve();
    },
    forgetPushTokens: (id) => {
      calls.push(`forget:${id}`);
      return Promise.resolve();
    },
    deleteUser: (id) => {
      calls.push(`deleteUser:${id}`);
      return options.failDeleteUser ? Promise.reject(new Error("auth down")) : Promise.resolve();
    },
    store,
    config: null,
    squareConfig: null,
  };
  return { deps, calls, state };
}

const request = (method = "DELETE") => new Request("https://example.test/functions/v1/account", { method, headers: { authorization: "Bearer jwt" } });

Deno.test("DELETE 以外と未ログインは消さない", async () => {
  const { deps, calls } = setup();
  assertEquals((await handleAccountRequest(request("POST"), deps)).status, 405);
  const anonymous = setup({ user: null });
  assertEquals((await handleAccountRequest(request(), anonymous.deps)).status, 401);
  assertEquals([...calls, ...anonymous.calls], []);
});

Deno.test("最後のメンバーならグループごと消し、最後にアカウントを消す", async () => {
  const { deps, calls, state } = setup({ connection: { ...baseConnection, connected_by: "other" }, square });
  const res = await handleAccountRequest(request(), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true });
  assertEquals(calls, ["deleteHousehold:h1", "forget:u1", "deleteUser:u1"]);
  assertEquals(state.connection, null);
  assertEquals(state.square, null);
});

Deno.test("ほかのメンバーがいればグループを残し、本人がつないだ接続だけを取り消す", async () => {
  const mine = setup({ members: 2, connection: { ...baseConnection, connected_by: "u1" }, square: { ...square, connected_by: "other" } });
  assertEquals((await handleAccountRequest(request(), mine.deps)).status, 200);
  assertEquals(mine.calls, ["forget:u1", "deleteUser:u1"]);
  assertEquals(mine.state.connection, null);
  assertEquals(mine.state.square?.connected_by, "other");
  assertEquals(mine.state.provider, "monban");

  const theirs = setup({ members: 2, connection: { ...baseConnection, connected_by: "other" } });
  await handleAccountRequest(request(), theirs.deps);
  assertEquals(theirs.state.connection?.connected_by, "other");
});

Deno.test("グループに入っていない人も消せる", async () => {
  const { deps, calls } = setup({ household: null });
  assertEquals((await handleAccountRequest(request(), deps)).status, 200);
  assertEquals(calls, ["forget:u1", "deleteUser:u1"]);
});

Deno.test("グループを消すときは、予約先の片付けの失敗でも続ける。残すグループでは止める", async () => {
  const last = setup({ connection: baseConnection, failDisconnect: true });
  assertEquals((await handleAccountRequest(request(), last.deps)).status, 200);
  assertEquals(last.calls, ["deleteHousehold:h1", "forget:u1", "deleteUser:u1"]);

  const shared = setup({ members: 2, connection: { ...baseConnection, connected_by: "u1" }, failDisconnect: true });
  assertEquals((await handleAccountRequest(request(), shared.deps)).status, 500);
  assertEquals(shared.calls, []);
});

Deno.test("アカウントを消せなければ 500 を返し、やり直せる", async () => {
  const { deps, calls } = setup({ failDeleteUser: true, household: null });
  const res = await handleAccountRequest(request(), deps);
  assertEquals(res.status, 500);
  assertEquals(calls, ["forget:u1", "deleteUser:u1"]);
});
