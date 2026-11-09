import { chimeFailureMessage, chimeStep } from '../domain/chime';
import { useDeviceGate } from '../lib/deviceGate';
import { SYMBOLS } from '../lib/symbols';
import { useChimeEnrollment } from '../lib/useChimeEnrollment';
import { OnboardingLayout } from './OnboardingLayout';
import { PrimaryButton, TextButton } from './ui';

// 本体の接続待ち、静かにする、鳴らす、確認、完了、失敗。初回の案内と設定の「チャイムを登録し直す」が共有する
export function ChimeEnrollmentFlow({
  householdId,
  onStart,
  onLater,
}: {
  householdId: string;
  // 登録の完了のあとの「はじめる」
  onStart: () => void;
  // 「あとで」
  onLater: () => void;
}) {
  const { refresh } = useDeviceGate();
  // 登録できたら、設定の「登録済み」が読めるように本体を読み直す
  const { view, restart } = useChimeEnrollment(householdId, refresh);
  const step = chimeStep(view);

  switch (view.kind) {
    case 'waiting_device':
      return (
        <OnboardingLayout
          icon={SYMBOLS.wifi}
          badge={{ kind: 'ring', label: '接続待ち', dash: 72, start: -60 }}
          title={'本体の接続を\n待っています'}
        >
          <TextButton label="あとで" onPress={onLater} />
        </OnboardingLayout>
      );
    case 'requesting':
    case 'quiet':
      return (
        <OnboardingLayout
          icon={SYMBOLS.microphone}
          badge={{ kind: 'ring', label: '周りの音を測っています', dash: 173, start: -90 }}
          title="静かにしてください"
          step={step}
        />
      );
    case 'listen':
      return (
        <OnboardingLayout
          icon={SYMBOLS.bell}
          badge={{ kind: 'halo', label: '音を待っています' }}
          title={'インターホンのピンポンを\n1回鳴らしてください'}
          step={step}
        />
      );
    case 'checking':
      return (
        <OnboardingLayout
          icon={SYMBOLS.waveform}
          badge={{ kind: 'ring', label: '確認中', dash: 72, start: -60 }}
          title="確認しています"
          step={step}
        />
      );
    case 'done':
      return (
        <OnboardingLayout icon={SYMBOLS.approve} badge={{ kind: 'filled' }} title={'ピンポン音を\n登録しました'}>
          <PrimaryButton label="はじめる" onPress={onStart} />
        </OnboardingLayout>
      );
    case 'failed':
    case 'timeout':
      return (
        <OnboardingLayout
          icon={SYMBOLS.alert}
          badge={{ kind: 'plain' }}
          title="登録できませんでした"
          message={chimeFailureMessage(view)}
        >
          <PrimaryButton label="もう一度登録する" onPress={restart} />
          <TextButton label="あとで" onPress={onLater} />
        </OnboardingLayout>
      );
  }
}
