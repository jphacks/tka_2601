import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { needsOnboarding } from '../domain/chime';
import type { Device } from '../domain/device';
import { useAuth } from './auth';
import { repositories } from './container';
import { clearOnboardingSkipped, readOnboardingSkipped, writeOnboardingSkipped } from './onboardingSkip';

type DeviceGateValue = {
  // 本体の有無を読み終えたか（グループに入る前は常に true）
  settled: boolean;
  // 本体を読めなかった。「本体なし」とは別で、初回の案内へ移さない
  failed: boolean;
  device: Device | null;
  // 初回の案内の途中か。案内を始めたら、本体を登録した後も終えるまで true のまま
  onboarding: boolean;
  refresh: () => Promise<void>;
  // 「あとで」。案内を終え、このお店では覚えておく
  skipOnboarding: () => Promise<void>;
  // 案内を終える（チャイムの登録を終えたとき）
  finishOnboarding: () => void;
};

type Loaded = { householdId: string; device: Device | null; failed: boolean };

const DeviceGateContext = createContext<DeviceGateValue | null>(null);

// グループの本体の有無を持つ。本体がなく「あとで」も押していないお店は、初回の案内へ進める。
// 読めなかったときは案内へ移さない（通信の失敗で、登録済みのお店に案内を出さない）
export function DeviceGateProvider({ children }: { children: ReactNode }) {
  const { household } = useAuth();
  const householdId = household?.id ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [onboardingFor, setOnboardingFor] = useState<string | null>(null);
  // 案内を出すか決めたお店。起動後の最初の読み込みで1度だけ決める
  const decidedFor = useRef<string | null>(null);
  const generation = useRef(0);

  // 本体を読み、初めての読み込みなら案内を出すかを決める。状態は変えない
  const load = useCallback(async (request: number) => {
    if (!householdId) return null;
    const device = await repositories.devices.get(householdId);
    if (request !== generation.current) return null;
    if (device) {
      // 本体が登録されたら、「あとで」の記憶は要らない
      void clearOnboardingSkipped(householdId);
    }
    let latch = false;
    if (decidedFor.current !== householdId) {
      const skipped = device ? true : await readOnboardingSkipped(householdId);
      if (request !== generation.current) return null;
      decidedFor.current = householdId;
      latch = needsOnboarding({ settled: true, failed: false, hasDevice: !!device, skipped });
    }
    return { device, latch };
  }, [householdId]);

  const refresh = useCallback((): Promise<void> => {
    if (!householdId) return Promise.resolve();
    const request = ++generation.current;
    return load(request).then(
      (result) => {
        if (!result) return;
        if (result.latch) setOnboardingFor(householdId);
        setLoaded({ householdId, device: result.device, failed: false });
      },
      () => {
        if (request !== generation.current) return;
        // 読めなかった起動では案内を出さない。あとで読めても、使っている途中で案内に移さない
        decidedFor.current ??= householdId;
        // 読めていた本体は保つ。一度も読めていなければ、案内へ移さず失敗として持つ
        setLoaded((current) => (current?.householdId === householdId ? current : { householdId, device: null, failed: true }));
      },
    );
  }, [householdId, load]);

  useEffect(() => {
    if (!householdId) return;
    void refresh();
    return () => {
      // 別のお店や別の人に変わったら、案内を出すかを決め直す
      decidedFor.current = null;
      generation.current += 1;
    };
  }, [householdId, refresh]);

  const skipOnboarding = useCallback(async () => {
    if (householdId) await writeOnboardingSkipped(householdId);
    setOnboardingFor(null);
  }, [householdId]);

  const finishOnboarding = useCallback(() => setOnboardingFor(null), []);

  const current = loaded?.householdId === householdId ? loaded : null;
  const value = useMemo<DeviceGateValue>(
    () => ({
      settled: !householdId || current !== null,
      failed: current?.failed ?? false,
      device: current?.device ?? null,
      onboarding: !!householdId && onboardingFor === householdId,
      refresh,
      skipOnboarding,
      finishOnboarding,
    }),
    [householdId, current, onboardingFor, refresh, skipOnboarding, finishOnboarding],
  );

  return <DeviceGateContext.Provider value={value}>{children}</DeviceGateContext.Provider>;
}

export function useDeviceGate(): DeviceGateValue {
  const value = useContext(DeviceGateContext);
  if (!value) throw new Error('useDeviceGate は DeviceGateProvider の内側で使う');
  return value;
}
