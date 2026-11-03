// アカウントの削除（docs/reservations.md 3.3）。App Store の審査 5.1.1(v) で必須。
// 残りのメンバーがいなければグループごと消す。いれば本人だけが抜け、本人がつないだ予約先の接続は取り消す
import { type CalendarStore, type GoogleConfig } from "../_shared/calendar_store.ts";
import type { SquareConfig } from "../_shared/square.ts";
import { disconnect } from "../reservations/google.ts";
import { disconnectSquare } from "../reservations/square.ts";

export type AccountDeps = {
  // 呼んだ人の id。null は未ログイン
  authenticate(req: Request): Promise<string | null>;
  householdOf(userId: string): Promise<string | null>;
  memberCount(householdId: string): Promise<number>;
  deleteHousehold(householdId: string): Promise<void>;
  // 通知の送り先と送信待ちを消す
  forgetPushTokens(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  store: CalendarStore;
  config: GoogleConfig | null;
  squareConfig: SquareConfig | null;
  fetch?: typeof fetch;
};

export async function handleAccountRequest(req: Request, deps: AccountDeps): Promise<Response> {
  if (req.method !== "DELETE") return Response.json({ error: "method not allowed" }, { status: 405 });
  try {
    const userId = await deps.authenticate(req);
    if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

    const householdId = await deps.householdOf(userId);
    if (householdId) {
      const lastMember = (await deps.memberCount(householdId)) <= 1;
      await revokeConnections(deps, householdId, userId, lastMember);
      if (lastMember) await deps.deleteHousehold(householdId);
    }
    await deps.forgetPushTokens(userId);
    // 最後に消す。途中で失敗しても、ログインしたままやり直せる
    await deps.deleteUser(userId);
    return Response.json({ deleted: true });
  } catch (e) {
    console.error("account deletion failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "アカウントを削除できませんでした" }, { status: 500 });
  }
}

// 予約先の取り消しに失敗しても削除は止めない。
// グループを消すなら接続の行は一緒に消えるので、片付けの失敗も無視する。残すグループでは、本人のトークンを残さないよう失敗を投げる
async function revokeConnections(deps: AccountDeps, householdId: string, userId: string, lastMember: boolean) {
  const ownsConnection = (connection: { connected_by: string | null } | null) =>
    connection !== null && (lastMember || connection.connected_by === userId);
  const steps = [
    async () => {
      if (ownsConnection(await deps.store.getConnection(householdId))) await disconnect({ ...deps }, householdId);
    },
    async () => {
      if (ownsConnection(await deps.store.getSquareConnection(householdId))) {
        await disconnectSquare(
          { store: deps.store, squareConfig: deps.squareConfig, fetch: deps.fetch, notify: noNotice, notifyOrThrow: noNotice },
          householdId,
        );
      }
    },
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      if (!lastMember) throw e;
      console.warn("予約先の接続を片付けられませんでした", e instanceof Error ? e.message : e);
    }
  }
}

const noNotice = () => Promise.resolve();
