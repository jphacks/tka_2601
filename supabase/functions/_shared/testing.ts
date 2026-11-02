// 試験で使う共通の部品（Deno のユニット試験だけが読む）
import type { CalendarConnection, CalendarStore, OAuthPending, OAuthState } from "./calendar_store.ts";
import type { ProviderKind } from "./reservation.ts";
import type { SquareConnection } from "./square.ts";

// URL と method で応答を決める fetch。呼ばれた内容を記録する
export function fakeGoogle(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      const body = new URLSearchParams(String(init.body ?? ""));
      if (body.get("grant_type") === "refresh_token") return Promise.resolve(Response.json({ access_token: "access" }));
    }
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fn as typeof fetch, calls };
}

// 本物の表と同じく、NOT NULL の列がない行は作れない（Postgres は衝突の判定より先に確かめる）
function requireColumns(table: string, row: Record<string, unknown>, columns: string[]) {
  for (const column of columns) {
    if (row[column] === undefined || row[column] === null) {
      throw new Error(`null value in column "${column}" of relation "${table}" violates not-null constraint`);
    }
  }
}

export function memoryStore(
  options: { connection?: CalendarConnection | null; square?: SquareConnection | null; provider?: ProviderKind; own?: string[] } = {},
) {
  const state = {
    connection: options.connection ?? null,
    provider: options.provider ?? ("monban" as ProviderKind),
    states: new Map<string, OAuthState>(),
    pending: new Map<string, OAuthPending>(),
    own: new Set(options.own ?? []),
    saved: [] as Partial<CalendarConnection>[],
    square: options.square ?? null,
    squareSaved: [] as Partial<SquareConnection>[],
    arrivals: new Map<string, string>(),
  };
  const store: CalendarStore = {
    getConnection: () => Promise.resolve(state.connection),
    saveConnection(connection) {
      requireColumns("calendar_connections", connection, ["household_id", "refresh_token_encrypted", "status"]);
      state.saved.push(connection);
      state.connection = { last_synced_at: null, ...connection };
      return Promise.resolve();
    },
    updateConnection(_, patch) {
      state.saved.push(patch);
      if (state.connection) state.connection = { ...state.connection, ...patch };
      return Promise.resolve();
    },
    deleteConnection() {
      state.connection = null;
      return Promise.resolve();
    },
    saveState(saved) {
      state.states.set(saved.state, { ...saved, created_at: new Date().toISOString() });
      return Promise.resolve();
    },
    takeState(key) {
      const saved = state.states.get(key) ?? null;
      state.states.delete(key);
      return Promise.resolve(saved);
    },
    savePending(pending) {
      state.pending.set(pending.code, { ...pending, created_at: new Date().toISOString() });
      return Promise.resolve();
    },
    takePending(code) {
      const pending = state.pending.get(code) ?? null;
      state.pending.delete(code);
      return Promise.resolve(pending);
    },
    getProviderKind: () => Promise.resolve(state.provider),
    setProviderKind(_, kind) {
      state.provider = kind;
      return Promise.resolve();
    },
    recordOwnWrite(_, eventId, etag) {
      state.own.add(`${eventId}:${etag}`);
      return Promise.resolve();
    },
    ownEtags: () => Promise.resolve(state.own),
    activeConnections: () => Promise.resolve(state.connection ? [state.connection] : []),
    getSquareConnection: () => Promise.resolve(state.square),
    squareConnectionByMerchant: (merchantId) => Promise.resolve(state.square?.merchant_id === merchantId ? state.square : null),
    saveSquareConnection(connection) {
      requireColumns("square_connections", connection, [
        "household_id",
        "merchant_id",
        "access_token_encrypted",
        "refresh_token_encrypted",
        "access_token_expires_at",
        "status",
      ]);
      state.squareSaved.push(connection);
      state.square = connection;
      return Promise.resolve();
    },
    updateSquareConnection(_, patch) {
      state.squareSaved.push(patch);
      if (state.square) state.square = { ...state.square, ...patch };
      return Promise.resolve();
    },
    deleteSquareConnection() {
      state.square = null;
      return Promise.resolve();
    },
    externalArrivals(_, __, ids) {
      return Promise.resolve(new Map([...state.arrivals].filter(([id]) => ids.includes(id))));
    },
    recordExternalArrival(_, __, id, arrivedAt) {
      state.arrivals.set(id, arrivedAt);
      return Promise.resolve();
    },
  };
  return { store, state };
}

export const baseConnection: CalendarConnection = {
  household_id: "h1",
  account_email: "shop@example.com",
  calendar_id: "cal@example.com",
  calendar_name: "予約",
  refresh_token_encrypted: "unused",
  sync_token: "token-1",
  status: "active",
  last_error: null,
  last_synced_at: "2026-11-02T00:00:00.000Z",
  connected_by: "u1",
};
