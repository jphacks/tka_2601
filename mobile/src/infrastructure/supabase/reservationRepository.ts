// 予約（Edge Function「reservations」。docs/reservations.md 3.1）
import type { ReservationRepository } from '../../repositories';
import { callFunction } from './functions';
import { toReservation, toReservationProvider } from './mappers';

type Row = Record<string, unknown>;

function itemPath(id: string): string {
  return `reservations/${encodeURIComponent(id)}`;
}

export const supabaseReservationRepository: ReservationRepository = {
  async list({ from, to }, status) {
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (status) query.set('status', status);
    const data = await callFunction<{ provider: unknown; reservations?: Row[] }>(`reservations?${query.toString()}`, 'GET');
    return {
      provider: toReservationProvider(data.provider),
      reservations: (data.reservations ?? []).map(toReservation),
    };
  },
  async get(id) {
    const { reservation } = await callFunction<{ reservation: Row }>(itemPath(id), 'GET');
    return toReservation(reservation);
  },
  async create(input, idempotencyKey) {
    const body = idempotencyKey ? { ...input, idempotency_key: idempotencyKey } : input;
    const { reservation } = await callFunction<{ reservation: Row }>('reservations', 'POST', body);
    return toReservation(reservation);
  },
  async update(id, patch, expected) {
    const body = expected
      ? { ...patch, expected_starts_at: expected.starts_at, expected_ends_at: expected.ends_at }
      : patch;
    const { reservation } = await callFunction<{ reservation: Row }>(itemPath(id), 'PATCH', body);
    return toReservation(reservation);
  },
  async approve(id) {
    await callFunction(`${itemPath(id)}/approve`, 'POST');
  },
  async cancel(id) {
    await callFunction(`${itemPath(id)}/cancel`, 'POST');
  },
  async arrive(id) {
    await callFunction(`${itemPath(id)}/arrive`, 'POST');
  },
};
