// 設定の「連携」に並べる外部サービス。どれも同時につなげる。アプリの予約一覧に出すのは、そのうち 1 つ
import type { ProviderState, ReservationProvider } from '../domain/reservation';

export type Integration = Exclude<ReservationProvider, 'monban'>;

export const INTEGRATIONS: readonly Integration[] = ['google_calendar', 'square', 'hotpepper'];

export function isIntegration(value: unknown): value is Integration {
  return typeof value === 'string' && (INTEGRATIONS as readonly string[]).includes(value);
}

// Google とホットペッパーは独立したフラグで表示を決める。
// Square は使用中なら、フラグがオフでも解除できるように残す。
export function visibleIntegrations(
  state: ProviderState | null,
  flags: { googleCalendar: boolean; hotpepper: boolean; externalProviders: boolean },
): Integration[] {
  return INTEGRATIONS.filter((integration) => {
    if (integration === 'google_calendar') return flags.googleCalendar;
    if (integration === 'hotpepper') return flags.hotpepper;
    return flags.externalProviders || state?.provider === integration;
  });
}

export function isConnected(state: ProviderState, integration: Integration): boolean {
  if (integration === 'google_calendar') return state.google.connected;
  if (integration === 'square') return state.square.connected;
  return true;
}

// 設定の一覧の右に出す文。ホットペッパーは API がないので、つなぐものがなく使うか使わないかだけ
export function integrationStatus(state: ProviderState, integration: Integration): string {
  if (state.provider === integration) return '使用中';
  if (integration === 'hotpepper') return '未使用';
  return isConnected(state, integration) ? '接続済み' : '未接続';
}

// 通知や設定から開く画面
export function integrationRoute(integration: Integration) {
  return { pathname: '/settings/integrations/[provider]', params: { provider: integration } } as const;
}

// 予約先との接続エラーの通知（calendar_sync_failed）は Google カレンダーの同期の失敗
export const INTEGRATION_ERROR_ROUTE = integrationRoute('google_calendar');

// 連携先の同意から戻った URL の問い合わせの読み方。resultParam は google か square。
// pending と code がそろえば、ログインした本人のセッションで完了する
export type OAuthOutcome = { kind: 'pending'; code: string } | { kind: 'error' } | { kind: 'none' };

export function oauthOutcome(query: Record<string, unknown> | null | undefined, resultParam: string): OAuthOutcome {
  const outcome = query?.[resultParam];
  if (outcome === 'error') return { kind: 'error' };
  const code = query?.code;
  if (outcome === 'pending' && typeof code === 'string' && code !== '') return { kind: 'pending', code };
  return { kind: 'none' };
}
