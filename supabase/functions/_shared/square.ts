// Square 予約を読む予約先（docs/reservations.md 2章）。Square は読み取りだけで、予約の写しは持たない。
// AI の仮予約は Square に書かず reservations 表に入れ、店が Square に入力してから承認する
import type { NewNotification } from "./notify.ts";
import {
  findOverlaps,
  type NewReservation,
  overlapError,
  ProviderError,
  type Reservation,
  type ReservationPatch,
  type ReservationProvider,
  type ReservationRange,
  type ReservationStatus,
  type ReservationWrite,
} from "./reservation.ts";
import { constantTimeEqual } from "./secret.ts";
import { decryptToken, encryptToken } from "./token_crypto.ts";

export const SQUARE_SCOPES = [
  "APPOINTMENTS_READ",
  "APPOINTMENTS_ALL_READ",
  "CUSTOMERS_READ",
  "ITEMS_READ",
  "MERCHANT_PROFILE_READ",
];
export const SQUARE_ID_PREFIX = "square:";
const CUSTOMER_FALLBACK = "お客様";
const CUSTOMER_BATCH = 100;
const CATALOG_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// GET /v2/bookings が1回で読む期間
const WINDOW_MS = 31 * DAY_MS;
// 期間より前に始まって重なる予約も読む。Square の検索は開始の時刻だけを見るため（メニューの所要時間の上限と同じ）
const LOOKBACK_MS = 12 * 60 * 60 * 1000;
// アクセストークンは 30 日で切れる。Square は 7 日以内ごとの更新を勧めているので、発行から 7 日で更新する
const REFRESH_MARGIN_MS = 23 * DAY_MS;

export type SquareConfig = {
  applicationId: string;
  applicationSecret: string;
  baseUrl: string;
  publicUrl: string;
  tokenKey: string;
  webhookSignatureKey: string | null;
};

export type SquareConnection = {
  household_id: string;
  merchant_id: string;
  merchant_name: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: string;
  status: "active" | "error";
  last_error: string | null;
  connected_by: string | null;
};

export type SquareBooking = {
  id: string;
  version?: number;
  status?: string;
  start_at?: string;
  customer_id?: string;
  customer_note?: string;
  appointment_segments?: { duration_minutes?: number; service_variation_id?: string }[];
};

export function squareBaseUrl(environment: string | undefined): string {
  return environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

// 接続の設定。Webhook の署名鍵のほかがそろっていなければ null
export function squareConfigFromEnv(): SquareConfig | null {
  const applicationId = Deno.env.get("SQUARE_APPLICATION_ID");
  const applicationSecret = Deno.env.get("SQUARE_APPLICATION_SECRET");
  const publicUrl = Deno.env.get("RESERVATIONS_PUBLIC_URL");
  const tokenKey = Deno.env.get("CALENDAR_TOKEN_KEY");
  if (!applicationId || !applicationSecret || !publicUrl || !tokenKey) return null;
  return {
    applicationId,
    applicationSecret,
    baseUrl: squareBaseUrl(Deno.env.get("SQUARE_ENVIRONMENT")),
    publicUrl: publicUrl.replace(/\/$/, ""),
    tokenKey,
    webhookSignatureKey: Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY") || null,
  };
}

// ログインし直さないと直らない失敗
export class SquareAuthError extends Error {}

// 一時的な失敗など
export class SquareApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// 通信の失敗も一時的な失敗として扱う
async function sendToSquare(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (e) {
    throw new SquareApiError(`Square network error: ${e instanceof Error ? e.message : String(e)}`, 0);
  }
}

export type SquareTokenStore = {
  updateSquareConnection(householdId: string, patch: Partial<Omit<SquareConnection, "household_id">>): Promise<void>;
};

// アクセストークンの更新と、接続の状態の記録
export class SquareTokens {
  constructor(
    private connection: SquareConnection,
    private readonly config: SquareConfig,
    private readonly store: SquareTokenStore,
    private readonly notify: (notification: NewNotification) => Promise<unknown>,
    private readonly doFetch: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async accessToken(): Promise<string> {
    const expiresAt = Date.parse(this.connection.access_token_expires_at);
    if (expiresAt - this.now().getTime() > REFRESH_MARGIN_MS) {
      return await decryptToken(this.connection.access_token_encrypted, this.config.tokenKey);
    }
    return await this.refresh();
  }

  private async refresh(): Promise<string> {
    const refreshToken = await decryptToken(this.connection.refresh_token_encrypted, this.config.tokenKey);
    const res = await sendToSquare(this.doFetch, `${this.config.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.applicationId,
        client_secret: this.config.applicationSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (res.status >= 500 || res.status === 429) throw new SquareApiError(`Square token HTTP ${res.status}`, res.status);
    const tokens = await res.json().catch(() => null);
    if (!res.ok || !tokens?.access_token || !tokens?.expires_at) {
      await this.markFailed(`トークンを更新できません（HTTP ${res.status}）`);
      throw new SquareAuthError(`Square token HTTP ${res.status}`);
    }
    const update = {
      access_token_encrypted: await encryptToken(tokens.access_token, this.config.tokenKey),
      access_token_expires_at: tokens.expires_at as string,
      status: "active" as const,
      last_error: null,
    };
    await this.store.updateSquareConnection(this.connection.household_id, update);
    this.connection = { ...this.connection, ...update };
    return tokens.access_token;
  }

  // 正常に読めたので、エラーの記録を消す
  async markHealthy(): Promise<void> {
    if (this.connection.status !== "error") return;
    await this.store.updateSquareConnection(this.connection.household_id, { status: "active", last_error: null });
    this.connection = { ...this.connection, status: "active", last_error: null };
  }

  // 接続を error にする。正常からエラーに変わったときだけ通知する
  async markFailed(message: string): Promise<void> {
    const wasActive = this.connection.status !== "error";
    await this.store.updateSquareConnection(this.connection.household_id, { status: "error", last_error: message });
    this.connection = { ...this.connection, status: "error", last_error: message };
    if (!wasActive) return;
    await this.notify({
      household_id: this.connection.household_id,
      kind: "calendar_sync_failed",
      title: "予約先との接続が切れました",
      body: "Square にログインし直してください",
      data: {},
      dedupe_key: `square_auth_failed:${this.now().toISOString()}`,
    });
  }
}

export class SquareClient {
  constructor(
    private readonly config: Pick<SquareConfig, "baseUrl">,
    private readonly tokens: Pick<SquareTokens, "accessToken" | "markFailed" | "markHealthy">,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  // 見つからないときは null
  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const token = await this.tokens.accessToken();
    const res = await sendToSquare(this.doFetch, `${this.config.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 404) return null;
    if (res.status === 401) {
      await this.tokens.markFailed("Square のログインが無効です");
      throw new SquareAuthError("Square HTTP 401");
    }
    if (!res.ok) throw new SquareApiError(`Square HTTP ${res.status} ${path.split("?")[0]}`, res.status);
    await this.tokens.markHealthy();
    return await res.json() as T;
  }

  // 開始の時刻が期間に入る予約。期間を 31 日ごとに分けて、すべてのページを読む
  async listBookings(startMin: Date, startMax: Date): Promise<SquareBooking[]> {
    const bookings = new Map<string, SquareBooking>();
    for (let start = startMin.getTime(); start < startMax.getTime(); start += WINDOW_MS) {
      const end = Math.min(start + WINDOW_MS, startMax.getTime());
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          start_at_min: new Date(start).toISOString(),
          start_at_max: new Date(end).toISOString(),
        });
        if (cursor) query.set("cursor", cursor);
        const page = await this.request<{ bookings?: SquareBooking[]; cursor?: string }>("GET", `/v2/bookings?${query}`);
        // 期間の境目の予約が重なっても1件にする
        for (const booking of page?.bookings ?? []) bookings.set(booking.id, booking);
        cursor = page?.cursor;
      } while (cursor);
    }
    return [...bookings.values()];
  }

  async getBooking(id: string): Promise<SquareBooking | null> {
    const page = await this.request<{ booking?: SquareBooking }>("GET", `/v2/bookings/${encodeURIComponent(id)}`);
    return page?.booking ?? null;
  }

  async customers(ids: string[]): Promise<Map<string, CustomerInfo>> {
    const customers = new Map<string, CustomerInfo>();
    for (let i = 0; i < ids.length; i += CUSTOMER_BATCH) {
      const page = await this.request<{
        responses?: Record<string, { customer?: { family_name?: string; given_name?: string; phone_number?: string } }>;
      }>("POST", "/v2/customers/bulk-retrieve", { customer_ids: ids.slice(i, i + CUSTOMER_BATCH) });
      for (const [id, response] of Object.entries(page?.responses ?? {})) {
        const customer = response.customer;
        if (!customer) continue;
        const name = [customer.family_name, customer.given_name].filter(Boolean).join(" ");
        customers.set(id, { name: name || CUSTOMER_FALLBACK, phone: customer.phone_number ?? null });
      }
    }
    return customers;
  }

  async serviceNames(variationIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (let i = 0; i < variationIds.length; i += CATALOG_BATCH) {
      const page = await this.request<CatalogResponse>("POST", "/v2/catalog/batch-retrieve", {
        object_ids: variationIds.slice(i, i + CATALOG_BATCH),
        include_related_objects: true,
      });
      for (const [id, name] of catalogNames(page ?? {})) names.set(id, name);
    }
    return names;
  }
}

export type CustomerInfo = { name: string; phone: string | null };

type CatalogObject = {
  id?: string;
  type?: string;
  item_data?: { name?: string; variations?: CatalogObject[] };
  item_variation_data?: { name?: string; item_id?: string };
};
type CatalogResponse = { objects?: CatalogObject[]; related_objects?: CatalogObject[] };

// 親の品目は objects の中にも related_objects の中にも入りうるので、両方から名前を集める。
// Square の品目のバリエーションは「Regular」のような名前が多いので、品目名を優先する
export function catalogNames(response: CatalogResponse): Map<string, string> {
  const objects = [...(response.objects ?? []), ...(response.related_objects ?? [])];
  const items = new Map<string, string>();
  const variations = new Map<string, { name?: string; itemId?: string }>();
  for (const object of objects) {
    if (object.item_data?.name && object.id) items.set(object.id, object.item_data.name);
    for (const variation of object.item_data?.variations ?? []) {
      if (variation.id) variations.set(variation.id, { name: variation.item_variation_data?.name, itemId: object.id });
    }
    if (object.item_variation_data && object.id) {
      variations.set(object.id, { name: object.item_variation_data.name, itemId: object.item_variation_data.item_id });
    }
  }
  const names = new Map<string, string>();
  for (const [id, variation] of variations) {
    const name = (variation.itemId && items.get(variation.itemId)) || variation.name;
    if (name) names.set(id, name);
  }
  return names;
}

export function bookingStatus(status: string | undefined): ReservationStatus {
  if (status === "PENDING") return "pending";
  if (status === "ACCEPTED") return "confirmed";
  return "cancelled";
}

export function isCancelledStatus(status: string | undefined): boolean {
  return bookingStatus(status) === "cancelled";
}

export function squareReservationId(bookingId: string): string {
  return `${SQUARE_ID_PREFIX}${bookingId}`;
}

// 開始の時刻がない予約は扱えないので null を返す
export function bookingToReservation(
  booking: SquareBooking,
  lookups: { customers?: Map<string, CustomerInfo>; services?: Map<string, string>; arrivals?: Map<string, string> } = {},
): Reservation | null {
  if (!booking.start_at) return null;
  const start = Date.parse(booking.start_at);
  if (Number.isNaN(start)) return null;
  const segments = booking.appointment_segments ?? [];
  const minutes = segments.reduce((total, segment) => total + (segment.duration_minutes ?? 0), 0);
  const customer = booking.customer_id ? lookups.customers?.get(booking.customer_id) : undefined;
  const variationId = segments[0]?.service_variation_id;
  return {
    id: squareReservationId(booking.id),
    customer_name: customer?.name ?? CUSTOMER_FALLBACK,
    customer_phone: customer?.phone ?? null,
    service_name: (variationId && lookups.services?.get(variationId)) || null,
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + minutes * 60_000).toISOString(),
    status: bookingStatus(booking.status),
    source: "external",
    note: booking.customer_note ?? null,
    arrived_at: lookups.arrivals?.get(booking.id) ?? null,
    visit_id: null,
    read_only: true,
  };
}

const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];

// 顧客名とメニューが読めなくても予約は見せる
export async function resolveBookings(
  client: Pick<SquareClient, "customers" | "serviceNames">,
  bookings: SquareBooking[],
): Promise<{ customers: Map<string, CustomerInfo>; services: Map<string, string> }> {
  const customerIds = unique(bookings.map((b) => b.customer_id));
  const variationIds = unique(bookings.flatMap((b) => (b.appointment_segments ?? []).map((s) => s.service_variation_id)));
  const [customers, services] = await Promise.all([
    customerIds.length ? client.customers(customerIds).catch(logLookupFailure<CustomerInfo>) : new Map<string, CustomerInfo>(),
    variationIds.length ? client.serviceNames(variationIds).catch(logLookupFailure<string>) : new Map<string, string>(),
  ]);
  return { customers, services };
}

function logLookupFailure<T>(e: unknown): Map<string, T> {
  console.warn("Square の顧客やメニューを読めませんでした", e instanceof Error ? e.message : e);
  return new Map();
}

export type SquareProviderDeps = {
  client: Pick<SquareClient, "listBookings" | "getBooking" | "customers" | "serviceNames">;
  // AI の仮予約を置く表
  ledger: Pick<ReservationProvider, "list" | "get" | "createIfFree" | "update" | "approve" | "cancel" | "arrive">;
  store: {
    externalArrivals(householdId: string, provider: "square", externalIds: string[]): Promise<Map<string, string>>;
    recordExternalArrival(householdId: string, provider: "square", externalId: string, arrivedAt: string): Promise<void>;
  };
  householdId: string;
  now?: () => Date;
};

const readOnlyError = () => new ProviderError(409, "Square の予約は Square で変更してください", "provider_read_only");

export class SquareProvider implements ReservationProvider {
  readonly kind = "square" as const;

  constructor(private readonly deps: SquareProviderDeps) {}

  private async toReservations(bookings: SquareBooking[]): Promise<Reservation[]> {
    const { customers, services } = await resolveBookings(this.deps.client, bookings);
    const arrivals = await this.deps.store.externalArrivals(this.deps.householdId, "square", bookings.map((b) => b.id));
    return bookings
      .map((booking) => bookingToReservation(booking, { customers, services, arrivals }))
      .filter((r): r is Reservation => r !== null);
  }

  // Square の予約と、表の仮予約を合わせて返す。表の確定は店が Square に入れた予約と二重になるので出さない
  async list({ from, to, status }: ReservationRange): Promise<Reservation[]> {
    const [bookings, ledger] = await Promise.all([
      this.deps.client.listBookings(new Date(Date.parse(from) - LOOKBACK_MS), new Date(to)),
      status === undefined || status === "pending" ? this.deps.ledger.list({ from, to, status: "pending" }) : Promise.resolve([]),
    ]);
    const matches = bookings.filter((b) => (status ? bookingStatus(b.status) === status : !isCancelledStatus(b.status)));
    const reservations = (await this.toReservations(matches))
      .filter((r) => Date.parse(r.starts_at) < Date.parse(to) && Date.parse(r.ends_at) > Date.parse(from));
    return [...reservations, ...ledger].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  }

  async get(id: string): Promise<Reservation | null> {
    if (!id.startsWith(SQUARE_ID_PREFIX)) return await this.deps.ledger.get(id);
    const booking = await this.deps.client.getBooking(id.slice(SQUARE_ID_PREFIX.length));
    if (!booking) return null;
    return (await this.toReservations([booking]))[0] ?? null;
  }

  // AI の仮予約だけを表に入れる。アプリから足すときは Square に入れてもらう
  async create(input: NewReservation): Promise<ReservationWrite> {
    return await this.createIfFree(input);
  }

  // Square の予約と表の仮予約の両方を見る。Square には同時の書き込みを止める手段がないので、そちらとの競合は承認リストで防ぐ
  async createIfFree(input: NewReservation): Promise<ReservationWrite> {
    if (input.source !== "ai") throw readOnlyError();
    if ((await findOverlaps(this, input.starts_at, input.ends_at)).length > 0) throw overlapError();
    return await this.deps.ledger.createIfFree(input);
  }

  async update(id: string, patch: ReservationPatch): Promise<ReservationWrite> {
    if (id.startsWith(SQUARE_ID_PREFIX)) throw readOnlyError();
    return await this.deps.ledger.update(id, patch);
  }

  async approve(id: string): Promise<ReservationWrite> {
    if (id.startsWith(SQUARE_ID_PREFIX)) throw readOnlyError();
    return await this.deps.ledger.approve(id);
  }

  async cancel(id: string): Promise<ReservationWrite> {
    if (id.startsWith(SQUARE_ID_PREFIX)) throw readOnlyError();
    return await this.deps.ledger.cancel(id);
  }

  async arrive(id: string): Promise<ReservationWrite> {
    if (!id.startsWith(SQUARE_ID_PREFIX)) return await this.deps.ledger.arrive(id);
    const current = await this.get(id);
    if (!current) throw new ProviderError(404, "予約が見つかりません");
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約です");
    const arrivedAt = current.arrived_at ?? (this.deps.now?.() ?? new Date()).toISOString();
    if (!current.arrived_at) {
      await this.deps.store.recordExternalArrival(this.deps.householdId, "square", id.slice(SQUARE_ID_PREFIX.length), arrivedAt);
    }
    // 到着は予約ごとに1回だけ通知する
    return { reservation: { ...current, arrived_at: arrivedAt }, dedupeKey: (kind) => `${id}:${kind}` };
  }
}

export async function squareSignature(signatureKey: string, notificationUrl: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signatureKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(notificationUrl + rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function hasValidSquareSignature(
  signatureKey: string,
  notificationUrl: string,
  rawBody: string,
  actual: string | null,
): Promise<boolean> {
  if (!actual) return false;
  return constantTimeEqual(actual, await squareSignature(signatureKey, notificationUrl, rawBody));
}

export type SquareNoticeKind = "reservation_pending" | "reservation_created" | "reservation_updated" | "reservation_cancelled";

export function classifyBookingEvent(type: string | undefined, booking: SquareBooking): SquareNoticeKind | null {
  if (type === "booking.created") return booking.status === "PENDING" ? "reservation_pending" : "reservation_created";
  if (type === "booking.updated") return isCancelledStatus(booking.status) ? "reservation_cancelled" : "reservation_updated";
  return null;
}

export function squareDedupeKey(booking: SquareBooking): string {
  return `${SQUARE_ID_PREFIX}${booking.id}:${booking.version ?? 0}`;
}
