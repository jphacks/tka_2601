// Supabase への読み書き。RPC の名前は supabase-rls セッションに依頼した形（共有ノートの app-backend-requests.md）
import { requireSupabase } from './supabase';
import type {
  Device,
  Household,
  InvitePreview,
  Member,
  Visit,
  VisitMessage,
  VisitSummary,
} from './types';

export const VISITS_PAGE_SIZE = 50;

type Membership = { household: Household } | null;

export async function fetchMembership(userId: string): Promise<Membership> {
  const { data, error } = await requireSupabase()
    .from('household_members')
    .select('household_id, households(id, name)')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const household = data.households as unknown as Household | null;
  return household ? { household } : null;
}

export async function createHousehold(name: string): Promise<string> {
  const { data, error } = await requireSupabase().rpc('create_household', { name });
  if (error) throw error;
  return data as string;
}

export async function getInvitePreview(token: string): Promise<InvitePreview | null> {
  const { data, error } = await requireSupabase().rpc('get_household_invite', { token });
  if (error) throw error;
  const rows = (data ?? []) as InvitePreview[];
  return rows[0] ?? null;
}

export async function acceptInvite(token: string): Promise<string> {
  const { data, error } = await requireSupabase().rpc('accept_household_invite', { token });
  if (error) throw error;
  return data as string;
}

export async function getOrCreateInviteToken(): Promise<string> {
  const { data, error } = await requireSupabase().rpc('get_or_create_household_invite');
  if (error) throw error;
  return data as string;
}

export async function listMembers(): Promise<Member[]> {
  const { data, error } = await requireSupabase().rpc('household_member_profiles');
  if (error) throw error;
  return (data ?? []) as Member[];
}

type VisitRow = Visit & { visit_messages: Pick<VisitMessage, 'text' | 'seq' | 'speaker'>[] | null };

// 来客を新しい順に。応答しなかったチャイム（missed）は出さない
export async function listVisits(householdId: string, page: number): Promise<VisitSummary[]> {
  const from = page * VISITS_PAGE_SIZE;
  const { data, error } = await requireSupabase()
    .from('visits')
    .select(
      'id, household_id, device_id, mode, chimed_at, answered_at, ended_at, status, intent, company, outcome, end_reason, visit_messages(text, seq, speaker)',
    )
    .eq('household_id', householdId)
    .neq('status', 'missed')
    .eq('visit_messages.speaker', 'visitor')
    .order('chimed_at', { ascending: false })
    .order('seq', { referencedTable: 'visit_messages', ascending: true })
    .limit(1, { referencedTable: 'visit_messages' })
    .range(from, from + VISITS_PAGE_SIZE - 1);
  if (error) throw error;
  return ((data ?? []) as unknown as VisitRow[]).map(({ visit_messages, ...visit }) => ({
    ...visit,
    first_visitor_text: visit_messages?.[0]?.text ?? null,
  }));
}

export async function getVisit(id: string): Promise<{ visit: Visit; messages: VisitMessage[] } | null> {
  const supabase = requireSupabase();
  const [visitResult, messagesResult] = await Promise.all([
    supabase
      .from('visits')
      .select(
        'id, household_id, device_id, mode, chimed_at, answered_at, ended_at, status, intent, company, outcome, end_reason',
      )
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('visit_messages')
      .select('visit_id, seq, speaker, text, spoken_at')
      .eq('visit_id', id)
      .order('seq', { ascending: true }),
  ]);
  if (visitResult.error) throw visitResult.error;
  if (messagesResult.error) throw messagesResult.error;
  if (!visitResult.data) return null;
  return { visit: visitResult.data as Visit, messages: (messagesResult.data ?? []) as VisitMessage[] };
}

export async function deleteVisit(id: string): Promise<void> {
  const { error } = await requireSupabase().from('visits').delete().eq('id', id);
  if (error) throw error;
}

// グループの本体。1つのグループに本体は1台の前提
export async function getDevice(householdId: string): Promise<Device | null> {
  const { data, error } = await requireSupabase()
    .from('devices')
    .select('id, household_id, name, mode, away_leave_at_door, auto_away, extra_instructions')
    .eq('household_id', householdId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Device | null) ?? null;
}

export type DevicePatch = Partial<Pick<Device, 'mode' | 'away_leave_at_door' | 'auto_away' | 'extra_instructions'>>;

export async function updateDevice(id: string, patch: DevicePatch): Promise<void> {
  const { error } = await requireSupabase().from('devices').update(patch).eq('id', id);
  if (error) throw error;
}

export async function savePushToken(userId: string, token: string): Promise<void> {
  const { error } = await requireSupabase()
    .from('push_tokens')
    .upsert({ user_id: userId, token, platform: 'ios', last_seen_at: new Date().toISOString() });
  if (error) throw error;
}

export async function deletePushToken(userId: string, token: string): Promise<void> {
  const { error } = await requireSupabase().from('push_tokens').delete().eq('user_id', userId).eq('token', token);
  if (error) throw error;
}
