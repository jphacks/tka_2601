import { keysetFilter } from '../../domain/collections';
import { VISITS_PAGE_SIZE } from '../../domain/visit';
import type { VisitRepository } from '../../repositories';
import { requireSupabase } from './client';
import { toVisit, toVisitMessage } from './mappers';

type VisitRow = Record<string, unknown> & { visit_messages?: { text?: string }[] | null };

export const supabaseVisitRepository: VisitRepository = {
  // 来客を新しい順に。応答しなかったチャイム（missed）は出さない
  async list(householdId, after) {
    let query = requireSupabase()
      .from('visits')
      .select(
        'id, household_id, device_id, mode, chimed_at, answered_at, ended_at, status, intent, company, outcome, end_reason, visit_messages(text, seq, speaker)',
      )
      .eq('household_id', householdId)
      .neq('status', 'missed')
      .eq('visit_messages.speaker', 'visitor');
    if (after) query = query.or(keysetFilter('chimed_at', after));
    const { data, error } = await query
      .order('chimed_at', { ascending: false })
      .order('id', { ascending: false })
      .order('seq', { referencedTable: 'visit_messages', ascending: true })
      .limit(1, { referencedTable: 'visit_messages' })
      .limit(VISITS_PAGE_SIZE);
    if (error) throw error;
    return ((data ?? []) as unknown as VisitRow[]).map((row) => ({
      ...toVisit(row),
      first_visitor_text: row.visit_messages?.[0]?.text ?? null,
    }));
  },
  async get(id) {
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
    return { visit: toVisit(visitResult.data), messages: (messagesResult.data ?? []).map(toVisitMessage) };
  },
  async remove(id) {
    const { error } = await requireSupabase().from('visits').delete().eq('id', id);
    if (error) throw error;
  },
};
