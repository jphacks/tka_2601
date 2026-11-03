// どの実装を使うかを決める唯一の場所。画面と hooks はここからリポジトリを受け取る
import { supabaseAccountRepository } from '../infrastructure/supabase/accountRepository';
import { supabaseAssistantRepository } from '../infrastructure/supabase/assistantRepository';
import { supabaseDeviceRepository } from '../infrastructure/supabase/deviceRepository';
import { supabaseGroupRepository } from '../infrastructure/supabase/groupRepository';
import { supabaseNotificationRepository } from '../infrastructure/supabase/notificationRepository';
import { supabaseProviderRepository } from '../infrastructure/supabase/providerRepository';
import { supabasePushTokenRepository } from '../infrastructure/supabase/pushTokenRepository';
import { supabaseReservationRepository } from '../infrastructure/supabase/reservationRepository';
import { supabaseShopRepository } from '../infrastructure/supabase/shopRepository';
import { supabaseVisitRepository } from '../infrastructure/supabase/visitRepository';
import type { Repositories } from '../repositories';

export const repositories: Repositories = {
  reservations: supabaseReservationRepository,
  providers: supabaseProviderRepository,
  visits: supabaseVisitRepository,
  devices: supabaseDeviceRepository,
  shop: supabaseShopRepository,
  notifications: supabaseNotificationRepository,
  assistant: supabaseAssistantRepository,
  groups: supabaseGroupRepository,
  pushTokens: supabasePushTokenRepository,
  account: supabaseAccountRepository,
};
