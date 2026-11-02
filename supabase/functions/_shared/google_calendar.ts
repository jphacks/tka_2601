// Google カレンダーの API と、予定と予約の変換（docs/reservations.md 2章）。
// 予約の写しは持たず、読むたびに API を呼ぶ。fetch は試験で差し替えられる
import {
  checkPatchedOrder,
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

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type GoogleEvent = {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  created?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

type EventsPage = { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };

// 更新トークンが無効になった（連携の解除など）。店が接続し直すまで直らない
export class GoogleAuthError extends Error {}

// API の失敗。5xx とネットワークは時間をおけば直る見込みがある
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
  get transient(): boolean {
    // レート制限は 403 でも返る
    if (this.status === 403 && RATE_LIMIT_REASONS.has(this.reason ?? "")) return true;
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

// 失敗の本文の error.errors[0].reason を読む
function errorReason(text: string): string | undefined {
  try {
    return JSON.parse(text)?.error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

// syncToken が無効になった（410）。起点を取り直す
export class GoogleSyncExpired extends Error {}

export type GoogleOAuthClient = { clientId: string; clientSecret: string };

export class GoogleClient {
  private cached: string | null = null;

  constructor(
    private readonly oauth: GoogleOAuthClient,
    private readonly refreshToken: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.cached) return this.cached;
    const res = await this.send(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = await res.json().catch(() => null);
    if (res.status === 400 || res.status === 401) {
      throw new GoogleAuthError(`Google のトークンを更新できません: ${json?.error ?? res.status}`);
    }
    if (!res.ok || !json?.access_token) throw new GoogleApiError(`Google token HTTP ${res.status}`, res.status);
    this.cached = json.access_token as string;
    return this.cached;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(url, init);
    } catch (e) {
      throw new GoogleApiError(`Google network error: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
  }

  // 成功の JSON を返す。404 は null
  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await this.send(`${CALENDAR_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new GoogleAuthError("Google の認証が無効です");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const reason = errorReason(text);
      if (res.status === 410) {
        // 410 は消された予定（deleted）と、syncToken の失効の両方で返る
        if (reason === "deleted") return null;
        throw new GoogleSyncExpired("syncToken が無効です");
      }
      throw new GoogleApiError(`Google Calendar HTTP ${res.status} ${text.slice(0, 200)}`, res.status, reason);
    }
    return await res.json() as T;
  }

  async listCalendars(): Promise<{ id: string; name: string; primary: boolean }[]> {
    type Page = { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[]; nextPageToken?: string };
    const calendars: { id: string; name: string; primary: boolean }[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ minAccessRole: "writer", maxResults: "250" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.request<Page>("GET", `/users/me/calendarList?${params}`);
      for (const c of page?.items ?? []) {
        calendars.push({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: c.primary === true });
      }
      pageToken = page?.nextPageToken;
    } while (pageToken);
    return calendars;
  }

  private eventsPath(calendarId: string, suffix = ""): string {
    return `/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;
  }

  private async pages(calendarId: string, params: URLSearchParams): Promise<{ items: GoogleEvent[]; nextSyncToken?: string }> {
    const items: GoogleEvent[] = [];
    let nextSyncToken: string | undefined;
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams(params);
      if (pageToken) query.set("pageToken", pageToken);
      const page = await this.request<EventsPage>("GET", this.eventsPath(calendarId, `?${query}`));
      if (!page) throw new GoogleApiError("カレンダーが見つかりません", 404);
      items.push(...(page.items ?? []));
      nextSyncToken = page.nextSyncToken;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  // 繰り返しの予定は1回ごとに展開する（singleEvents）。キャンセルは showDeleted のときだけ返る
  listEvents(calendarId: string, from: string, to: string, showDeleted = false): Promise<{ items: GoogleEvent[] }> {
    return this.pages(calendarId, new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: from,
      timeMax: to,
      maxResults: "250",
      ...(showDeleted ? { showDeleted: "true" } : {}),
    }));
  }

  // 差分の起点を取る。今より後の予定だけを数えるが、中身は使わない
  async baseline(calendarId: string, now: string): Promise<string> {
    const { nextSyncToken } = await this.pages(calendarId, new URLSearchParams({
      singleEvents: "true",
      timeMin: now,
      maxResults: "2500",
    }));
    if (!nextSyncToken) throw new GoogleApiError("Google が syncToken を返しませんでした", 500);
    return nextSyncToken;
  }

  // 前回からの差分。削除された予定も入る
  async changes(calendarId: string, syncToken: string): Promise<{ items: GoogleEvent[]; nextSyncToken: string }> {
    const { items, nextSyncToken } = await this.pages(calendarId, new URLSearchParams({
      singleEvents: "true",
      syncToken,
      maxResults: "2500",
    }));
    if (!nextSyncToken) throw new GoogleApiError("Google が syncToken を返しませんでした", 500);
    return { items, nextSyncToken };
  }

  getEvent(calendarId: string, id: string): Promise<GoogleEvent | null> {
    return this.request<GoogleEvent>("GET", this.eventsPath(calendarId, `/${encodeURIComponent(id)}`));
  }

  async insertEvent(calendarId: string, event: Partial<GoogleEvent>): Promise<GoogleEvent> {
    const created = await this.request<GoogleEvent>("POST", this.eventsPath(calendarId, "?sendUpdates=none"), event);
    if (!created) throw new GoogleApiError("カレンダーが見つかりません", 404);
    return created;
  }

  async patchEvent(calendarId: string, id: string, patch: Partial<GoogleEvent>): Promise<GoogleEvent> {
    const updated = await this.request<GoogleEvent>(
      "PATCH",
      this.eventsPath(calendarId, `/${encodeURIComponent(id)}?sendUpdates=none`),
      patch,
    );
    if (!updated) throw new ProviderError(404, "予約が見つかりません");
    return updated;
  }
}

const toStatus = (status: GoogleEvent["status"]): ReservationStatus =>
  status === "tentative" ? "pending" : status === "cancelled" ? "cancelled" : "confirmed";

// 時刻のない終日の予定は予約として扱わないので null を返す
export function eventToReservation(event: GoogleEvent): Reservation | null {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start || !end) return null;
  const monban = event.extendedProperties?.private ?? {};
  const source = monban.monban_source;
  return {
    id: event.id,
    customer_name: monban.monban_customer_name ?? event.summary ?? "（件名なし）",
    customer_phone: monban.monban_customer_phone ?? null,
    service_name: monban.monban_service_name ?? null,
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(end).toISOString(),
    status: toStatus(event.status),
    source: source === "app" || source === "ai" ? source : "external",
    note: event.description ?? null,
    arrived_at: monban.monban_arrived_at ?? null,
    visit_id: monban.monban_visit_id ?? null,
    read_only: false,
  };
}

function summary(name: string, service: string | null | undefined): string {
  return service ? `${name}様 ${service}` : `${name}様`;
}

export function reservationToEvent(input: NewReservation): Partial<GoogleEvent> {
  const monban: Record<string, string> = {
    monban_source: input.source,
    monban_customer_name: input.customer_name,
  };
  if (input.customer_phone) monban.monban_customer_phone = input.customer_phone;
  if (input.service_name) monban.monban_service_name = input.service_name;
  if (input.visit_id) monban.monban_visit_id = input.visit_id;
  return {
    summary: summary(input.customer_name, input.service_name),
    ...(input.note ? { description: input.note } : {}),
    start: { dateTime: input.starts_at },
    end: { dateTime: input.ends_at },
    status: input.status === "pending" ? "tentative" : "confirmed",
    extendedProperties: { private: monban },
  };
}

// 変えた項目だけを PATCH で送る。Google で直接作られた予定も MONBAN の項目を持てるようになる
export function patchToEvent(current: Reservation, patch: ReservationPatch): Partial<GoogleEvent> {
  const event: Partial<GoogleEvent> = {};
  const monban: Record<string, string | null> = {};
  if (patch.customer_name !== undefined) monban.monban_customer_name = patch.customer_name;
  if (patch.customer_phone !== undefined) monban.monban_customer_phone = patch.customer_phone;
  if (patch.service_name !== undefined) monban.monban_service_name = patch.service_name;
  if (patch.customer_name !== undefined || patch.service_name !== undefined) {
    event.summary = summary(patch.customer_name ?? current.customer_name, patch.service_name !== undefined ? patch.service_name : current.service_name);
  }
  if (patch.note !== undefined) event.description = patch.note ?? "";
  if (patch.starts_at !== undefined) event.start = { dateTime: patch.starts_at };
  if (patch.ends_at !== undefined) event.end = { dateTime: patch.ends_at };
  // 値を null にして PATCH すると Google からキーが消える
  if (Object.keys(monban).length > 0) {
    event.extendedProperties = { private: monban as Record<string, string> };
  }
  return event;
}

export function eventVersion(event: GoogleEvent): string {
  return event.etag ?? event.updated ?? event.status ?? "";
}

export function googleDedupeKey(event: GoogleEvent): string {
  return `google:${event.id}:${eventVersion(event)}`;
}

export class GoogleProvider implements ReservationProvider {
  readonly kind = "google_calendar" as const;

  constructor(
    private readonly client: GoogleClient,
    private readonly calendarId: string,
    // 自分で書いた版を記録する。差分を読んだときに同じ変更を通知しないため
    private readonly recordOwnWrite: (eventId: string, etag: string) => Promise<void>,
  ) {}

  async list({ from, to, status }: ReservationRange): Promise<Reservation[]> {
    const { items } = await this.client.listEvents(this.calendarId, from, to, status === "cancelled");
    const reservations = items.map(eventToReservation).filter((r): r is Reservation => r !== null);
    return status ? reservations.filter((r) => r.status === status) : reservations.filter((r) => r.status !== "cancelled");
  }

  async get(id: string): Promise<Reservation | null> {
    const event = await this.client.getEvent(this.calendarId, id);
    return event ? eventToReservation(event) : null;
  }

  private async requireReservation(id: string): Promise<Reservation> {
    const reservation = await this.get(id);
    if (!reservation) throw new ProviderError(404, "予約が見つかりません");
    return reservation;
  }

  private async toWrite(event: GoogleEvent): Promise<ReservationWrite> {
    await this.recordOwnWrite(event.id, eventVersion(event));
    const reservation = eventToReservation(event);
    if (!reservation) throw new ProviderError(502, "Google カレンダーから予定の時刻を読めませんでした");
    return { reservation, dedupeKey: () => googleDedupeKey(event) };
  }

  async create(input: NewReservation): Promise<ReservationWrite> {
    return this.toWrite(await this.client.insertEvent(this.calendarId, reservationToEvent(input)));
  }

  // カレンダーには同時の書き込みを止める手段がないので、読んでから書くまでの重なりは承認リストで防ぐ
  async createIfFree(input: NewReservation): Promise<ReservationWrite> {
    if ((await findOverlaps(this, input.starts_at, input.ends_at)).length > 0) throw overlapError();
    return await this.create(input);
  }

  async update(id: string, patch: ReservationPatch): Promise<ReservationWrite> {
    const current = await this.requireReservation(id);
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約は変更できません");
    checkPatchedOrder(current, patch);
    return this.toWrite(await this.client.patchEvent(this.calendarId, id, patchToEvent(current, patch)));
  }

  async approve(id: string): Promise<ReservationWrite> {
    const current = await this.requireReservation(id);
    if (current.status !== "pending") throw new ProviderError(409, "仮予約ではありません");
    return this.toWrite(await this.client.patchEvent(this.calendarId, id, { status: "confirmed" }));
  }

  // すでにキャンセルや到着済みなら書かない。版が変わらないので二重に通知もしない
  async cancel(id: string): Promise<ReservationWrite> {
    const event = await this.client.getEvent(this.calendarId, id);
    if (!event || !eventToReservation(event)) throw new ProviderError(404, "予約が見つかりません");
    if (event.status === "cancelled") return this.toWrite(event);
    return this.toWrite(await this.client.patchEvent(this.calendarId, id, { status: "cancelled" }));
  }

  async arrive(id: string): Promise<ReservationWrite> {
    const event = await this.client.getEvent(this.calendarId, id);
    const current = event ? eventToReservation(event) : null;
    if (!event || !current) throw new ProviderError(404, "予約が見つかりません");
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約です");
    if (current.arrived_at) return this.toWrite(event);
    return this.toWrite(await this.client.patchEvent(this.calendarId, id, {
      extendedProperties: { private: { monban_arrived_at: new Date().toISOString() } },
    }));
  }
}
