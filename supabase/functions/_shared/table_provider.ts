// MONBAN の予約帳。予約先が monban か hotpepper の店は reservations 表を読み書きする
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  checkPatchedOrder,
  type NewReservation,
  ProviderError,
  type Reservation,
  type ReservationPatch,
  type ReservationProvider,
  type ReservationRange,
  type ReservationWrite,
} from "./reservation.ts";

const COLUMNS =
  "id, customer_name, customer_phone, service_name, starts_at, ends_at, status, source, note, arrived_at, visit_id, updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 1000;

type Row = Omit<Reservation, "read_only"> & { updated_at: string };

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
    if (error) throw error;
    return toWrite(data as unknown as Row);
  }

  private async write(id: string, values: Record<string, unknown>): Promise<ReservationWrite> {
    const { data, error } = await this.admin.from("reservations").update(values)
      .eq("household_id", this.householdId)
      .eq("id", id)
      .select(COLUMNS)
      .single();
    if (error) throw error;
    return toWrite(data as unknown as Row);
  }

  async update(id: string, patch: ReservationPatch): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約は変更できません");
    checkPatchedOrder(toReservation(current), patch);
    return this.write(id, patch);
  }

  async approve(id: string): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status !== "pending") throw new ProviderError(409, "仮予約ではありません");
    return this.write(id, { status: "confirmed" });
  }

  // すでにキャンセルや到着済みなら書かない。版が変わらないので二重に通知もしない
  async cancel(id: string): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    return current.status === "cancelled" ? toWrite(current) : this.write(id, { status: "cancelled" });
  }

  async arrive(id: string): Promise<ReservationWrite> {
    const current = await this.requireRow(id);
    if (current.status === "cancelled") throw new ProviderError(409, "キャンセルした予約です");
    return current.arrived_at ? toWrite(current) : this.write(id, { arrived_at: new Date().toISOString() });
  }
}
