import type { GoogleCalendar } from '../../domain/reservation';
import type { ReservationProviderRepository } from '../../repositories';
import { callFunction } from './functions';
import { toProviderState } from './mappers';

type Row = Record<string, unknown>;

export const supabaseProviderRepository: ReservationProviderRepository = {
  async getState() {
    return toProviderState(await callFunction<Row>('reservations/provider', 'GET'));
  },
  async select(provider) {
    return toProviderState(await callFunction<Row>('reservations/provider', 'PUT', { provider }));
  },
  async startGoogleLogin(returnUrl) {
    const { url } = await callFunction<{ url: string }>('reservations/google/start', 'POST', { return_url: returnUrl });
    return url;
  },
  async completeGoogleLogin(code) {
    return toProviderState(await callFunction<Row>('reservations/google/complete', 'POST', { code }));
  },
  async listGoogleCalendars() {
    const { calendars } = await callFunction<{ calendars: GoogleCalendar[] }>('reservations/google/calendars', 'GET');
    return calendars;
  },
  async selectGoogleCalendar(calendarId) {
    await callFunction('reservations/google/calendar', 'PUT', { calendar_id: calendarId });
  },
  async logoutGoogle() {
    await callFunction('reservations/google', 'DELETE');
  },
  async startSquareLogin(returnUrl) {
    const { url } = await callFunction<{ url: string }>('reservations/square/start', 'POST', { return_url: returnUrl });
    return url;
  },
  async completeSquareLogin(code) {
    return toProviderState(await callFunction<Row>('reservations/square/complete', 'POST', { code }));
  },
  async logoutSquare() {
    await callFunction('reservations/square', 'DELETE');
  },
};
