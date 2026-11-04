import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, GroupHeader, InfoRow, NavTextButton, RadioRow, Separator, TextButton } from '../../components/ui';
import type { Device } from '../../domain/device';
import {
  PUSHER_SYNC_LABELS,
  PusherSettingsChanged,
  pusherCapabilities,
  pusherConfig,
  pusherSyncState,
  samePusherConfig,
  type PusherConfig,
  type PusherId,
  type PusherSettings,
} from '../../domain/pusher';
import { useHousehold } from '../../lib/auth';
import { confirmAction } from '../../lib/confirm';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { colors } from '../../theme';

function pusherLabel(id: PusherId): string {
  return id === 'p1' ? 'プッシャー1' : 'プッシャー2';
}

function checkedTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('ja-JP');
}

export default function PusherSettingsScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [reload, setReload] = useState(0);
  const [device, setDevice] = useState<Device | null>(null);
  const [snapshot, setSnapshot] = useState<PusherSettings | null>(null);
  const [baseline, setBaseline] = useState<PusherConfig | null>(null);
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [count, setCount] = useState<1 | 2 | null>(null);
  const [start, setStart] = useState<PusherId | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedScope = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    const scope = `${household.id}:${reload}`;
    mountedScope.current = scope;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setLoadError(null);
    setRefreshError(null);
    setSaveMessage(null);

    async function poll(deviceId: string) {
      try {
        if (!savingRef.current) {
          const next = await repositories.pusherSettings.get(deviceId);
          if (active && !savingRef.current) {
            setSnapshot((previous) => previous && next && previous.desired_revision > next.desired_revision ? previous : next);
            setRefreshError(null);
          }
        }
      } catch {
        if (active) setRefreshError('反映状況を更新できません。通信を確認して、もう一度読み込んでください。');
      } finally {
        if (active) timer = setTimeout(() => void poll(deviceId), 5000);
      }
    }

    void (async () => {
      try {
        const currentDevice = await repositories.devices.get(household.id);
        const settings = currentDevice ? await repositories.pusherSettings.get(currentDevice.id) : null;
        if (!active) return;
        setDevice(currentDevice);
        setSnapshot(settings);
        const config = settings?.desired_config ?? settings?.applied_config ?? null;
        setBaseline(config);
        setExpectedRevision(settings?.desired_revision ?? 0);
        setCount(config ? config.enabled_pushers.length as 1 | 2 : null);
        setStart(config?.assignments.call_start ?? null);
        if (currentDevice) timer = setTimeout(() => void poll(currentDevice.id), 5000);
      } catch (e) {
        if (active) setLoadError(errorMessage(e) ?? '読み込めませんでした。');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      if (mountedScope.current === scope) mountedScope.current = null;
      if (timer) clearTimeout(timer);
    };
  }, [household.id, reload]));

  const config = count && start ? pusherConfig(count, start) : null;
  const dirty = count !== (baseline?.enabled_pushers.length ?? null) || start !== (baseline?.assignments.call_start ?? null);
  const state = pusherSyncState(snapshot);
  const capabilities = pusherCapabilities(snapshot?.capabilities);
  const changedElsewhere = (snapshot?.desired_revision ?? 0) !== expectedRevision;
  const editable = !loading && !loadError && !!device && !saving && state !== 'unsupported';
  const canSave = editable && !!config && (!snapshot?.desired_config || !samePusherConfig(config, baseline)) && !changedElsewhere;
  const confirmedAt = checkedTime(snapshot?.reported_at ?? snapshot?.applied_at ?? null);

  function chooseCount(next: 1 | 2) {
    setCount(next);
    setSaveMessage(null);
  }

  function back() {
    if (saving) return;
    if (dirty) {
      confirmAction({ title: '保存していない変更を破棄しますか', confirmLabel: '破棄して戻る', onConfirm: () => router.back() });
    } else router.back();
  }

  function readLatest() {
    if (saving) return;
    const refresh = () => setReload((value) => value + 1);
    if (dirty) confirmAction({ title: '編集内容を破棄して最新の設定を読み込みますか', confirmLabel: '読み直す', onConfirm: refresh });
    else refresh();
  }

  async function save() {
    if (!canSave || !device || !config || savingRef.current) return;
    const scope = mountedScope.current;
    setSaving(true);
    savingRef.current = true;
    setSaveMessage(null);
    try {
      const saved = await repositories.pusherSettings.save(device.id, expectedRevision, config);
      if (!scope || mountedScope.current !== scope) return;
      setSnapshot(saved);
      setBaseline(saved.desired_config);
      setExpectedRevision(saved.desired_revision);
      setRefreshError(null);
      setSaveMessage('設定を保存しました。本体への反映完了を確認してから取り付けを変更してください。');
    } catch (e) {
      if (!scope || mountedScope.current !== scope) return;
      if (e instanceof PusherSettingsChanged) {
        setSaveMessage(e.message);
        try {
          const latest = await repositories.pusherSettings.get(device.id);
          if (mountedScope.current === scope) setSnapshot(latest);
        } catch {
          if (mountedScope.current === scope) setRefreshError('最新の設定を取得できません。通信を確認して読み直してください。');
        }
      } else Alert.alert('保存できませんでした', errorMessage(e) ?? '編集中の値はそのまま残っています。');
    } finally {
      savingRef.current = false;
      if (mountedScope.current === scope) setSaving(false);
    }
  }

  return (
    <Screen waves={false}>
      <NavBar title="プッシャー設定" backLabel="設定" onBack={back}
        right={<NavTextButton label="保存" disabled={!canSave} loading={saving} onPress={save} />} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <GroupHeader title="対象の本体" first />
        <Card><InfoRow label="本体" value={loading ? '読み込み中' : device?.name ?? (device ? 'MONBAN' : '登録されていません')} /></Card>

        {loadError ? <Text style={styles.note} accessibilityRole="alert">{loadError}</Text> : null}
        {!loading && !loadError && device ? (
          <>
            <GroupHeader title="本体への反映" />
            <Card>
              <View style={styles.status} accessible accessibilityLiveRegion="polite">
                <Text style={styles.statusTitle}>{PUSHER_SYNC_LABELS[state]}</Text>
                {state === 'manual_check_required' ? <Text style={styles.detail}>親機を手動で終話し、USB調整画面で待機状態を確認してください。</Text> : null}
                {state === 'pending' ? <Text style={styles.detail}>{snapshot?.apply_error === 'busy' ? '本体の操作が終わるまで反映を待っています。' : '本体が設定を取得して保存すると、反映済みに変わります。'}</Text> : null}
                {state === 'unknown' ? <Text style={styles.detail}>接続や設定の対応状況はまだ確認できていません。</Text> : null}
                {state === 'failed' ? <Text style={styles.detail}>本体は直前の設定を使用しています。本体と通信の状態を確認してください。</Text> : null}
                {state === 'unsupported' ? <Text style={styles.detail}>プッシャー設定に対応したファームウェアへ更新してください。</Text> : null}
                {confirmedAt ? <Text style={styles.detail}>本体の最終確認　{confirmedAt}</Text> : null}
              </View>
            </Card>

            <GroupHeader title="通話に使う個数" />
            <Card>
              <RadioRow label="1個" value="開始・終話を同じ1個で操作" selected={count === 1} disabled={!editable} onPress={() => chooseCount(1)} />
              <Separator />
              <RadioRow label="2個" value="開始・終話を別々に操作" selected={count === 2} disabled={!editable} onPress={() => chooseCount(2)} />
            </Card>

            {count ? (
              <>
                <GroupHeader title={count === 1 ? '使用するプッシャー' : '通話開始の担当'} />
                <Card>
                  {(['p1', 'p2'] as const).map((id, index) => {
                    const gpio = capabilities?.pushers.find((p) => p.id === id)?.gpio;
                    return <Fragment key={id}>
                      {index ? <Separator /> : null}
                      <RadioRow label={pusherLabel(id)} value={gpio === undefined ? undefined : `GPIO ${gpio}`}
                        selected={start === id} disabled={!editable} onPress={() => { setStart(id); setSaveMessage(null); }} />
                    </Fragment>;
                  })}
                </Card>
              </>
            ) : null}

            {config ? (
              <>
                <GroupHeader title="機能の割り当て" />
                <Card>
                  <InfoRow label="通話開始" value={pusherLabel(config.assignments.call_start)} />
                  <Separator />
                  <InfoRow label="終話" value={pusherLabel(config.assignments.call_end)} />
                </Card>
              </>
            ) : <Text style={styles.note}>使用する個数とプッシャーを選んでください。</Text>}

            <Text style={styles.note}>個数は使用する数です。接続数の自動検出ではありません。角度と押下時間はUSB調整画面で設定します。</Text>
            <Text style={styles.note}>保存だけでは動きません。通話中の変更は終了後に反映します。</Text>
            {changedElsewhere ? <Text style={styles.note} accessibilityRole="alert">別のメンバーが設定を変更しました。編集内容を確認し、最新の設定を読み直してください。</Text> : null}
            {saveMessage ? <Text style={styles.note} accessibilityLiveRegion="polite">{saveMessage}</Text> : null}
            {refreshError ? <Text style={styles.note} accessibilityRole="alert">{refreshError}</Text> : null}
          </>
        ) : null}
        <TextButton label="最新の設定を読み直す" disabled={saving || loading} onPress={readLatest} style={styles.retry} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { marginHorizontal: 28, marginTop: 12, color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  status: { paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  statusTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  detail: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  retry: { marginTop: 12 },
});
