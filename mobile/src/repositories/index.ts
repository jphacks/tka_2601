// 画面が使う操作の入口。実装は infrastructure にあり、lib/container.ts で組み立てる。
// ボイスエージェントの仕様が変わっても、画面ではなく実装と変換の層を直して吸収する
import type { AssistantProposal } from '../domain/assistant';
import type { Device, DevicePatch } from '../domain/device';
import type { Household, InvitePreview, Member } from '../domain/group';
import type { AppNotification, NotificationKind, NotificationPreference } from '../domain/notification';
import type {
  DateRange,
  GoogleCalendar,
  ProviderState,
  Reservation,
  ReservationInput,
  ReservationProvider,
  ReservationStatus,
} from '../domain/reservation';
import type { ServiceInput, ShopProfile, ShopProfilePatch, ShopService } from '../domain/shop';
import type { Visit, VisitMessage, VisitSummary } from '../domain/visit';

export interface ReservationRepository {
  list(range: DateRange, status?: ReservationStatus): Promise<{ provider: ReservationProvider; reservations: Reservation[] }>;
  get(id: string): Promise<Reservation>;
  create(input: ReservationInput): Promise<Reservation>;
  update(id: string, patch: Partial<ReservationInput>): Promise<Reservation>;
  approve(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  arrive(id: string): Promise<void>;
}

export interface ReservationProviderRepository {
  getState(): Promise<ProviderState>;
  select(provider: ReservationProvider): Promise<ProviderState>;
  startGoogleLogin(returnUrl: string): Promise<string>;
  completeGoogleLogin(code: string): Promise<ProviderState>;
  listGoogleCalendars(): Promise<GoogleCalendar[]>;
  selectGoogleCalendar(calendarId: string): Promise<void>;
  logoutGoogle(): Promise<void>;
  startSquareLogin(returnUrl: string): Promise<string>;
  completeSquareLogin(code: string): Promise<ProviderState>;
  logoutSquare(): Promise<void>;
}

export interface VisitRepository {
  list(householdId: string, page: number): Promise<VisitSummary[]>;
  get(id: string): Promise<{ visit: Visit; messages: VisitMessage[] } | null>;
  remove(id: string): Promise<void>;
}

export interface DeviceRepository {
  get(householdId: string): Promise<Device | null>;
  update(id: string, patch: DevicePatch): Promise<void>;
}

export interface ShopRepository {
  getProfile(householdId: string): Promise<ShopProfile | null>;
  updateProfile(householdId: string, patch: ShopProfilePatch): Promise<void>;
  rename(householdId: string, name: string): Promise<void>;
  listServices(householdId: string): Promise<ShopService[]>;
  createService(householdId: string, input: ServiceInput, sortOrder: number): Promise<void>;
  updateService(id: string, input: ServiceInput): Promise<void>;
  removeService(id: string): Promise<void>;
}

export interface NotificationRepository {
  list(householdId: string, page: number): Promise<AppNotification[]>;
  getReadThrough(userId: string): Promise<string | null>;
  saveReadThrough(userId: string, readThrough: string): Promise<void>;
  countUnread(householdId: string, userId: string, readThrough: string | null): Promise<number>;
  listKinds(): Promise<NotificationKind[]>;
  listPreferences(userId: string): Promise<NotificationPreference[]>;
  savePreference(userId: string, kind: string, enabled: boolean): Promise<void>;
}

export interface AssistantRepository {
  // 文を読み取って案を返す。何も書き込まない
  parse(text: string): Promise<AssistantProposal>;
}

export interface GroupRepository {
  getMembership(userId: string): Promise<{ household: Household } | null>;
  create(name: string): Promise<string>;
  getInvitePreview(token: string): Promise<InvitePreview | null>;
  acceptInvite(token: string): Promise<string>;
  getOrCreateInviteToken(): Promise<string>;
  listMembers(): Promise<Member[]>;
}

export interface PushTokenRepository {
  save(userId: string, token: string): Promise<void>;
  remove(userId: string, token: string): Promise<void>;
}

export type Repositories = {
  reservations: ReservationRepository;
  providers: ReservationProviderRepository;
  visits: VisitRepository;
  devices: DeviceRepository;
  shop: ShopRepository;
  notifications: NotificationRepository;
  assistant: AssistantRepository;
  groups: GroupRepository;
  pushTokens: PushTokenRepository;
};
