// Google カレンダーの接続の読み書きと、店の予約先の解決
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { GoogleClient, type GoogleOAuthClient, GoogleProvider } from "./google_calendar.ts";
import { type ProviderKind, ProviderError, type ReservationProvider, selectProvider } from "./reservation.ts";
import { notifySafely } from "./notify.ts";
import { SquareClient, type SquareConfig, squareConfigFromEnv, type SquareConnection, SquareProvider, SquareTokens } from "./square.ts";
import { TableProvider } from "./table_provider.ts";
import { decryptToken } from "./token_crypto.ts";

export type CalendarConnection = {
  household_id: string;
  account_email: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  refresh_token_encrypted: string;
  sync_token: string | null;
  status: "active" | "error";
  last_error: string | null;
  last_synced_at: string | null;
  connected_by: string | null;
};

// 接続を作るときに渡す項目。NOT NULL の列を含むので、一部だけの更新には使えない
export type NewCalendarConnection = Omit<CalendarConnection, "last_synced_at">;
export type CalendarConnectionPatch = Partial<Omit<CalendarConnection, "household_id">>;
export type SquareConnectionPatch = Partial<Omit<SquareConnection, "household_id">>;

// 読み取りが途中で落ちたときに権利が切れるまでの時間。普段の読み取りより十分に長くする
const SYNC_LEASE_SECONDS = 300;

export type OwnWrite = { write_id: string; event_id: string | null };

export type OAuthProvider = "google_calendar" | "square";
export type OAuthState = {
  state: string;
  household_id: string;
  user_id: string;
  return_url: string;
  provider: OAuthProvider;
  created_at: string;
};

// 同意が済み、本人の確認を待っているトークン
export type OAuthPending = {
  code: string;
  provider: OAuthProvider;
  household_id: string;
  user_id: string;
  payload_encrypted: string;
  created_at: string;
};

export type GoogleConfig = GoogleOAuthClient & { publicUrl: string; tokenKey: string };

// OAuth の設定。4つそろっていなければ null
export function googleConfigFromEnv(): GoogleConfig | null {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const publicUrl = Deno.env.get("RESERVATIONS_PUBLIC_URL");
  const tokenKey = Deno.env.get("CALENDAR_TOKEN_KEY");
  if (!clientId || !clientSecret || !publicUrl || !tokenKey) return null;
  return { clientId, clientSecret, publicUrl: publicUrl.replace(/\/$/, ""), tokenKey };
}

// 関数と試験の間で差し替える入口
export interface CalendarStore {
  getConnection(householdId: string): Promise<CalendarConnection | null>;
  // 接続を作る。すでにあれば置き換える
  saveConnection(connection: NewCalendarConnection): Promise<void>;
  // 接続の一部を変える。接続がなければ何もしない
  updateConnection(householdId: string, patch: CalendarConnectionPatch): Promise<void>;
  deleteConnection(householdId: string): Promise<void>;
  saveState(state: Omit<OAuthState, "created_at">): Promise<void>;
  // 使い切り。取り出すと消える
  takeState(state: string): Promise<OAuthState | null>;
  savePending(pending: Omit<OAuthPending, "created_at">): Promise<void>;
  // 使い切り。取り出すと消える
  takePending(code: string): Promise<OAuthPending | null>;
  getProviderKind(householdId: string): Promise<ProviderKind>;
  setProviderKind(householdId: string, kind: ProviderKind): Promise<void>;
  // 予定を書く前に、自分の書き込みの id を記録する
  recordOwnWrite(householdId: string, writeId: string, eventId: string | null): Promise<void>;
  // 書き込みの id か予定の id が合う記録を返す
  ownWrites(householdId: string, writeIds: string[], eventIds: string[]): Promise<OwnWrite[]>;
  // 差分で確かめた記録を消す。消さないと、あとで店が Google で直接変えた分まで自分の変更に見える
  consumeOwnWrites(householdId: string, writeIds: string[]): Promise<void>;
  // 接続ごとの差分の読み取りの権利。別の回が読んでいる間は取れない
  acquireSyncLease(householdId: string): Promise<boolean>;
  releaseSyncLease(householdId: string): Promise<void>;
  // Google を予約先にしていて、カレンダーを選び終えた接続
  activeConnections(): Promise<CalendarConnection[]>;
  getSquareConnection(householdId: string): Promise<SquareConnection | null>;
  squareConnectionByMerchant(merchantId: string): Promise<SquareConnection | null>;
  saveSquareConnection(connection: SquareConnection): Promise<void>;
  updateSquareConnection(householdId: string, patch: SquareConnectionPatch): Promise<void>;
  deleteSquareConnection(householdId: string): Promise<void>;
  // 予約先の予約について MONBAN だけが持つ到着の時刻
  externalArrivals(householdId: string, provider: "square", externalIds: string[]): Promise<Map<string, string>>;
  recordExternalArrival(householdId: string, provider: "square", externalId: string, arrivedAt: string): Promise<void>;
}

// .in() の値は URL に入るので、長くなりすぎないように分けて問い合わせる
const IN_BATCH = 50;

function batches<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += IN_BATCH) result.push(values.slice(i, i + IN_BATCH));
  return result;
}

export function createCalendarStore(admin: SupabaseClient): CalendarStore {
  return {
    async getConnection(householdId) {
      const { data, error } = await admin.from("calendar_connections").select("*").eq("household_id", householdId).maybeSingle();
      if (error) throw error;
      return data as CalendarConnection | null;
    },
    async saveConnection(connection) {
      const { error } = await admin.from("calendar_connections").upsert({ ...connection, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    async updateConnection(householdId, patch) {
      const { error } = await admin.from("calendar_connections")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("household_id", householdId);
      if (error) throw error;
    },
    async deleteConnection(householdId) {
      const { error } = await admin.from("calendar_connections").delete().eq("household_id", householdId);
      if (error) throw error;
    },
    async saveState(state) {
      const { error } = await admin.from("calendar_oauth_states").insert(state);
      if (error) throw error;
    },
    async takeState(state) {
      const { data, error } = await admin.from("calendar_oauth_states").delete().eq("state", state).select("*").maybeSingle();
      if (error) throw error;
      return data as OAuthState | null;
    },
    async savePending(pending) {
      const { error } = await admin.from("calendar_oauth_pending").insert(pending);
      if (error) throw error;
    },
    async takePending(code) {
      const { data, error } = await admin.from("calendar_oauth_pending").delete().eq("code", code).select("*").maybeSingle();
      if (error) throw error;
      return data as OAuthPending | null;
    },
    async getProviderKind(householdId) {
      const { data, error } = await admin.from("shop_profiles").select("reservation_provider").eq("household_id", householdId).maybeSingle();
      if (error) throw error;
      return (data?.reservation_provider ?? "monban") as ProviderKind;
    },
    async setProviderKind(householdId, kind) {
      const { error } = await admin.from("shop_profiles").update({ reservation_provider: kind }).eq("household_id", householdId);
      if (error) throw error;
    },
    async recordOwnWrite(householdId, writeId, eventId) {
      const { error } = await admin.from("calendar_own_writes").insert({ household_id: householdId, write_id: writeId, event_id: eventId });
      if (error) throw error;
    },
    async ownWrites(householdId, writeIds, eventIds) {
      const found = new Map<string, OwnWrite>();
      const read = async (column: "write_id" | "event_id", values: string[]) => {
        for (const batch of batches(values)) {
          const { data, error } = await admin.from("calendar_own_writes").select("write_id, event_id")
            .eq("household_id", householdId)
            .in(column, batch);
          if (error) throw error;
          for (const row of data as OwnWrite[]) found.set(row.write_id, row);
        }
      };
      await read("write_id", writeIds);
      await read("event_id", eventIds);
      return [...found.values()];
    },
    async consumeOwnWrites(householdId, writeIds) {
      for (const batch of batches(writeIds)) {
        const { error } = await admin.from("calendar_own_writes").delete().eq("household_id", householdId).in("write_id", batch);
        if (error) throw error;
      }
    },
    async acquireSyncLease(householdId) {
      const { data, error } = await admin.rpc("calendar_sync_acquire", { p_household_id: householdId, p_seconds: SYNC_LEASE_SECONDS });
      if (error) throw error;
      return data === true;
    },
    async releaseSyncLease(householdId) {
      const { error } = await admin.rpc("calendar_sync_release", { p_household_id: householdId });
      if (error) throw error;
    },
    async activeConnections() {
      const { data: profiles, error } = await admin.from("shop_profiles").select("household_id").eq("reservation_provider", "google_calendar");
      if (error) throw error;
      const ids = (profiles as { household_id: string }[]).map((p) => p.household_id);
      if (ids.length === 0) return [];
      const { data, error: connectionError } = await admin.from("calendar_connections").select("*")
        .in("household_id", ids)
        .not("calendar_id", "is", null);
      if (connectionError) throw connectionError;
      return data as CalendarConnection[];
    },
    async getSquareConnection(householdId) {
      const { data, error } = await admin.from("square_connections").select("*").eq("household_id", householdId).maybeSingle();
      if (error) throw error;
      return data as SquareConnection | null;
    },
    async squareConnectionByMerchant(merchantId) {
      const { data, error } = await admin.from("square_connections").select("*").eq("merchant_id", merchantId).maybeSingle();
      if (error) throw error;
      return data as SquareConnection | null;
    },
    async saveSquareConnection(connection) {
      const { error } = await admin.from("square_connections").upsert({ ...connection, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    async updateSquareConnection(householdId, patch) {
      const { error } = await admin.from("square_connections")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("household_id", householdId);
      if (error) throw error;
    },
    async deleteSquareConnection(householdId) {
      const { error } = await admin.from("square_connections").delete().eq("household_id", householdId);
      if (error) throw error;
    },
    async externalArrivals(householdId, provider, externalIds) {
      const arrivals = new Map<string, string>();
      for (const batch of batches(externalIds)) {
        const { data, error } = await admin.from("reservation_external_states").select("external_id, arrived_at")
          .eq("household_id", householdId)
          .eq("provider", provider)
          .in("external_id", batch)
          .not("arrived_at", "is", null);
        if (error) throw error;
        for (const r of data as { external_id: string; arrived_at: string }[]) {
          arrivals.set(r.external_id, new Date(r.arrived_at).toISOString());
        }
      }
      return arrivals;
    },
    async recordExternalArrival(householdId, provider, externalId, arrivedAt) {
      const { error } = await admin.from("reservation_external_states").upsert({
        household_id: householdId,
        provider,
        external_id: externalId,
        arrived_at: arrivedAt,
      });
      if (error) throw error;
    },
  };
}

export async function clientForConnection(connection: CalendarConnection, config: GoogleConfig, doFetch: typeof fetch = fetch): Promise<GoogleClient> {
  const refreshToken = await decryptToken(connection.refresh_token_encrypted, config.tokenKey);
  return new GoogleClient(config, refreshToken, doFetch);
}

// 店の予約先を実装に解決する
export async function providerFor(admin: SupabaseClient, householdId: string): Promise<ReservationProvider> {
  const store = createCalendarStore(admin);
  const kind = await store.getProviderKind(householdId);
  return await selectProvider<ReservationProvider | Promise<ReservationProvider>>(kind, {
    table: (tableKind) => new TableProvider(admin, householdId, tableKind),
    google: async () => {
      const config = googleConfigFromEnv();
      if (!config) throw new ProviderError(503, "Google カレンダーの接続が設定されていません", "google_not_configured");
      const connection = await store.getConnection(householdId);
      if (!connection?.calendar_id) throw new ProviderError(409, "Google カレンダーの接続が済んでいません", "google_not_connected");
      const client = await clientForConnection(connection, config);
      return new GoogleProvider(client, connection.calendar_id, (writeId, eventId) => store.recordOwnWrite(householdId, writeId, eventId));
    },
    square: async () => {
      const config = squareConfigFromEnv();
      if (!config) throw new ProviderError(503, "Square の接続が設定されていません", "square_not_configured");
      const connection = await store.getSquareConnection(householdId);
      if (!connection) throw new ProviderError(409, "Square の接続が済んでいません", "square_not_connected");
      return new SquareProvider({
        client: squareClientFor(admin, store, connection, config),
        // 表の確定は SquareProvider が Square の予約と照らして数えるので、表の中では仮予約だけを数える
        ledger: new TableProvider(admin, householdId, "monban", ["pending"]),
        store,
        householdId,
      });
    },
  });
}

export function squareClientFor(admin: SupabaseClient, store: CalendarStore, connection: SquareConnection, config: SquareConfig): SquareClient {
  return new SquareClient(config, new SquareTokens(connection, config, store, (notification) => notifySafely(admin, notification)));
}
