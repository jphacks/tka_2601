import type { SymbolViewProps } from 'expo-symbols';

import type { Intent, Mode } from '../domain/visit';

// iOS は SF Symbols、Android は Material Symbols の名前
export type SymbolName = Required<Pick<Exclude<SymbolViewProps['name'], string>, 'ios' | 'android'>>;

export const SYMBOLS = {
  plus: { ios: 'plus', android: 'add' },
  decline: { ios: 'xmark', android: 'close' },
  approve: { ios: 'checkmark', android: 'check' },
  arrived: { ios: 'checkmark.circle', android: 'check_circle' },
  assistant: { ios: 'sparkles', android: 'auto_awesome' },
  clock: { ios: 'clock', android: 'schedule' },
  calendar: { ios: 'calendar', android: 'calendar_today' },
  calendarAdd: { ios: 'calendar.badge.plus', android: 'calendar_add_on' },
  calendarRemove: { ios: 'calendar.badge.minus', android: 'event_busy' },
  person: { ios: 'person', android: 'person' },
  people: { ios: 'person.2', android: 'group' },
  personAdd: { ios: 'person.badge.plus', android: 'person_add' },
  bubble: { ios: 'bubble.left', android: 'chat_bubble' },
  bubbles: { ios: 'bubble.left.and.bubble.right', android: 'forum' },
  instructions: { ios: 'text.bubble', android: 'edit_note' },
  offline: { ios: 'wifi.slash', android: 'wifi_off' },
  warning: { ios: 'exclamationmark.triangle', android: 'warning' },
  bell: { ios: 'bell', android: 'notifications' },
  unknown: { ios: 'questionmark', android: 'question_mark' },
  parcel: { ios: 'shippingbox', android: 'package_2' },
  sales: { ios: 'megaphone', android: 'campaign' },
  service: { ios: 'wrench.and.screwdriver', android: 'construction' },
  walk: { ios: 'figure.walk', android: 'directions_walk' },
  pause: { ios: 'pause.circle', android: 'pause_circle' },
  shop: { ios: 'storefront', android: 'storefront' },
  list: { ios: 'list.bullet', android: 'list' },
  privacy: { ios: 'hand.raised', android: 'privacy_tip' },
  logout: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout' },
  trash: { ios: 'trash', android: 'delete' },
  door: { ios: 'door.left.hand.closed', android: 'door_front' },
  card: { ios: 'creditcard', android: 'credit_card' },
  scissors: { ios: 'scissors', android: 'content_cut' },
  device: { ios: 'hifispeaker', android: 'speaker' },
  wifi: { ios: 'wifi', android: 'wifi' },
  microphone: { ios: 'mic', android: 'mic' },
  waveform: { ios: 'waveform', android: 'graphic_eq' },
  alert: { ios: 'exclamationmark.circle', android: 'error' },
} satisfies Record<string, SymbolName>;

const INTENT_SYMBOLS: Record<Intent, SymbolName> = {
  delivery: SYMBOLS.parcel,
  sales: SYMBOLS.sales,
  service: SYMBOLS.service,
  acquaintance: SYMBOLS.person,
  emergency: SYMBOLS.warning,
  unknown: SYMBOLS.unknown,
};

export function intentSymbol(intent: Intent | null): SymbolName {
  return INTENT_SYMBOLS[intent ?? 'unknown'];
}

const NOTIFICATION_SYMBOLS: Record<string, SymbolName> = {
  chime: SYMBOLS.people,
  ended: SYMBOLS.bubble,
  reservation_pending: SYMBOLS.clock,
  reservation_created: SYMBOLS.calendarAdd,
  reservation_updated: SYMBOLS.calendar,
  reservation_cancelled: SYMBOLS.calendarRemove,
  reservation_arrived: SYMBOLS.arrived,
  device_offline: SYMBOLS.offline,
  calendar_sync_failed: SYMBOLS.warning,
};

// 種類は表で増えるので、知らない種類はベルで出す
export function notificationSymbol(kind: string): SymbolName {
  return NOTIFICATION_SYMBOLS[kind] ?? SYMBOLS.bell;
}

export const MODE_SYMBOLS: Record<Mode, SymbolName> = {
  normal: SYMBOLS.person,
  omakase: SYMBOLS.assistant,
  away: SYMBOLS.walk,
  off: SYMBOLS.pause,
};
