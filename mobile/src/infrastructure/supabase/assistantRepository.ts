// 自然言語の入力（Edge Function「assistant」。docs/reservations.md 8章）
import type { AssistantRepository } from '../../repositories';
import { callFunction } from './functions';
import { toAssistantProposal } from './mappers';

export const supabaseAssistantRepository: AssistantRepository = {
  async parse(text) {
    const { proposal } = await callFunction<{ proposal: unknown }>('assistant/parse', 'POST', { text });
    return toAssistantProposal(proposal);
  },
};
