import { router } from 'expo-router';

import { OnboardingLayout } from '../../components/OnboardingLayout';
import { PrimaryButton, TextButton } from '../../components/ui';
import { useDeviceGate } from '../../lib/deviceGate';
import { SYMBOLS } from '../../lib/symbols';

// 本体のないお店が最初に開く画面。「あとで」でもアプリは本体なしで使える
export default function OnboardingGuideScreen() {
  const { skipOnboarding } = useDeviceGate();
  return (
    <OnboardingLayout icon={SYMBOLS.device} badge={{ kind: 'plain' }} title="本体を登録しますか">
      <PrimaryButton label="登録する" onPress={() => router.push('/onboarding/code')} />
      <TextButton label="あとで" onPress={() => void skipOnboarding()} />
    </OnboardingLayout>
  );
}
