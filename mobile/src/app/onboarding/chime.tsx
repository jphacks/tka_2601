import { ChimeEnrollmentFlow } from '../../components/ChimeEnrollmentFlow';
import { useHousehold } from '../../lib/auth';
import { useDeviceGate } from '../../lib/deviceGate';

// 初回の案内の続き。登録を終えても「あとで」でも、案内を終えるとアプリへ移る
export default function OnboardingChimeScreen() {
  const household = useHousehold();
  const { finishOnboarding, skipOnboarding } = useDeviceGate();
  return (
    <ChimeEnrollmentFlow
      householdId={household.id}
      onStart={finishOnboarding}
      onLater={() => void skipOnboarding()}
    />
  );
}
