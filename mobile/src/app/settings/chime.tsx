import { router } from 'expo-router';

import { ChimeEnrollmentFlow } from '../../components/ChimeEnrollmentFlow';
import { useHousehold } from '../../lib/auth';

// 設定の「チャイムを登録し直す」。終えたら設定へ戻る
export default function SettingsChimeScreen() {
  const household = useHousehold();
  return (
    <ChimeEnrollmentFlow
      householdId={household.id}
      onStart={() => router.back()}
      onLater={() => router.back()}
    />
  );
}
