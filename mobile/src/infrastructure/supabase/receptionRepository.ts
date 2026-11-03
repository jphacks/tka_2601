// 受付の設定と Google カレンダー連携（Edge Function「door」。ボイスバックエンドの API を中継する）
import type { ReceptionRepository } from '../../repositories';
import { callFunction } from './functions';
import { toReceptionCalendar, toReceptionEvent, toReceptionGoogle, toReceptionVisit } from './mappers';

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => typeof item === 'object' && item !== null) : [];
}

export const supabaseReceptionRepository: ReceptionRepository = {
  async isReady() {
    const status = await callFunction<Row>('door/status', 'GET');
    return status.ready === true;
  },
  async getGuidance() {
    const data = await callFunction<Row>('door/reception/settings', 'GET');
    return typeof data.text === 'string' ? data.text : '';
  },
  async saveGuidance(text) {
    await callFunction('door/reception/settings', 'PUT', { text });
  },
  async listVisits() {
    return rows(await callFunction<unknown>('door/reception/visits', 'GET')).map(toReceptionVisit);
  },
  async getGoogle() {
    return toReceptionGoogle(await callFunction<Row>('door/google-calendar/status', 'GET'));
  },
  async startGoogleLogin() {
    const { url } = await callFunction<{ url: string }>('door/google-calendar/start', 'POST');
    return url;
  },
  async logoutGoogle() {
    await callFunction('door/google-calendar/disconnect', 'POST');
  },
  async listGoogleCalendars() {
    return rows(await callFunction<unknown>('door/google-calendar/calendars', 'GET')).map(toReceptionCalendar);
  },
  async selectGoogleCalendar(calendarId) {
    await callFunction('door/google-calendar/select', 'POST', { calendar_id: calendarId });
  },
  async listGoogleEvents() {
    return rows(await callFunction<unknown>('door/google-calendar/events', 'GET')).map(toReceptionEvent);
  },
};
