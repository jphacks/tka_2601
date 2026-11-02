// MONBAN の予約帳。予約先が monban か hotpepper の店は reservations 表を読み書きする
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  changedError,
  checkExpectedVersion,
  checkPatchedOrder,
  type ExpectedVersion,
  type NewReservation,
  ProviderError,
  type Reservation,
  overlapError,
  type ReservationPatch,
  type ReservationProvider,
  type ReservationRange,
  type ReservationStatus,
  type ReservationWrite,
} from "./reservation.ts";

const COLUMNS =
  "id, customer_name, customer_phone, service_name, starts_at, ends_at, status, source, note, arrived_at, visit_id, updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 1000;

type Row = Omit<Reservation, "read_only"> & { updated_at: string };
type StatusFilter = "pending" | "active";

function toReservation(row: Row): Reservation {
  const { updated_at: _, ...reservation } = row;
  return {
    ...reservation,
    starts_at: new Date(row.starts_at).toISOString(),
    ends_at: new Date(row.ends_at).toISOString(),
    arrived_at: row.arrived_at ? new Date(row.arrived_at).toISOString() : null,
    read_only: false,
  };
}

function toWrite(row: Row): ReservationWrite {
  return {
    reservation: toReservation(row),
    dedupeKey: (kind) => `reservation:${row.id}:${row.updated_at}:${kind}`,
  };
}

export class TableProvider implements ReservationProvider {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly householdId: string,
    readonly kind: "monban" | "hotpepper",
    // 重なりとして数える状態
    private readonly blockingStatuses: ReservationStatus[] = ["pending", "confirmed"],
  ) {}

  async list({ from, to, status }: ReservationRange): Promise<Reservation[]> {
    let query = this.admin.from("reservations").select(COLUMNS)
      .eq("household_id", this.householdId)
      .lt("starts_at", to)
      .gt("ends_at", from);
    query = status ? query.eq("status", status) : query.neq("status", "cancelled");
    const { data, error } = await query.order("starts_at").limit(MAX_ROWS);
    if (error) throw error;
    return (data as unknown as Row[]).map(toReservation);
  }

  private async row(id: string): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { data, error } = await this.admin.from("reservations").select(COLUMNS)
      .eq("household_id", this.householdId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data as unknown as Row | null;
  }

  private async requireRow(id: string): Promise<Row> {
    const row = await this.row(id);
    if (!row) throw new ProviderError(404, "予約が見つかりません");
    return row;
  }

  async get(id: string): Promise<Reservation | null> {
    const row = await this.row(id);
    return row ? toReservation(row) : null;
  }

  async create(input: NewReservation): Promise<ReservationWrite> {
    const { data, error } = await this.admin.from("reservations")
      .insert({ ...input, household_id: this.householdId })
      .select(COLUMNS)
      .single();
    if (error) {
      // 同じ冪等キーで作り終えていた
      if (error.code === "23505" && input.idempotency_key) return await this.existing(input.idempotency_key);
      throw error;
    }
    return toWrite(data as unknown as Row);
  }

  private async existing(idempotencyKey: string): Promise<ReservationWrite> {
    const { data, error } = await this.admin.from("reservations").select(COLUMNS)
      .eq("household_id", this.householdId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ProviderError(404, "予約が見つかりません");
    return { ...toWrite(data as unknown as Row), existed: true };
  }

  // 同じ店の予約を1つずつ処理する関数で、重なりを確かめてから作る
  async createIfFree(input: NewReservation): Promise<ReservationWrite> {
    const { data, error } = await this.admin.rpc("reservation_create_if_free", {
      p_household_id: this.householdId,
      p_customer_name: input.customer_name,
      p_customer_phone: input.customer_phone,
      p_service_name: input.service_name,
      p_starts_at: input.starts_at,
      p_ends_at: input.ends_at,
      p_note: input.note,
      p_status: input.status,
      p_source: input.source,
      p_visit_id: input.visit_id,
      p_blocking_statuses: this.blockingStatuses,
    }).select(COLUMNS).single();
    if (error) {
      if (error.code === "PT409") throw overlapError();
      throw error;
    }
    return toWrite(data as unknown as Row);
  }

  // 読んでから書くまでに状態が変わっていたら書かない。そのときは null を返す
  private async write(
    id: string,
    values: Record<string, unknown>,
    expected: StatusFilter,
    times: Pick<Row, "starts_at" | "ends_at"> | null = null,
  ): Promise<ReservationWrite | null> {
    let query = this.admin.from("reservations").update(values)
      .eq("household_id", this.householdId)
      .eq("id", id);
    query = expected === "pending" ? query.eq("status", "pending") : query.neq("status", "cancelled");
    if (times) query = query.eq("starts_at", times.starts_at).eq("ends_at", times.ends_at);
    const { data, error } = await query.select(COLUMNS).maybeSingle();
    if (error) throw error;
    return data ? toWrite(data as unknown as Row) : null;
  }

  async update(id: string, patch: ReservationPatch, expected?: ExpectedVersion): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約は変更できません");
    checkExpectedVersion(toReservation(current), expected);
    checkPatchedOrder(toReservation(current), patch);
    const written = await this.write(id, patch, "active", expected ? current : null);
    if (written) return written;
    // 読んでから書くまでに、別の操作が先に変えた
    if (expected && (await this.requireRow(id)).status !== "cancelled") throw changedError();
    throw new ProviderError(409, "キャンセルした予約は変更できません");
  }

  async approve(id: string): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status !== "pending") throw new ProviderError(409, "仮予約ではありません");
    const written = await this.write(id, { status: "confirmed" }, "pending");
    if (!written) throw new ProviderError(409, "仮予約ではありません");
    return written;
  }

  // すでにキャンセルや到着済みなら書かない。版が変わらないので二重に通知もしない
  async cancel(id: string): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status === "cancelled") return toWrite(current);
    return await this.write(id, { status: "cancelled" }, "active") ?? toWrite(await this.requireRow(id));
  }

  async arrive(id: string): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約です");
    if (current.arrived_at) return toWrite(current);
    const written = await this.write(id, { arrived_at: new Date().toISOString() }, "active");
    if (!written) throw new ProviderError(409, "キャンセルした予約です");
    return written;
  }
}
