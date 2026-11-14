// 連携の Google カレンダーの画面に出す「受付での照合」。ボイスバックエンドが来店と予約を照らす Google の接続
import { useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import type { ReceptionCalendar, ReceptionEvent, ReceptionGoogle } from '../domain/reception';
import { confirmAction } from '../lib/confirm';
import { repositories } from '../lib/container';
import { ApiError, errorMessage } from '../lib/errors';
import { hourMinute } from '../lib/format';
import { colors } from '../theme';
import { Card, GroupHeader, InfoRow, IntentBadge, PrimaryButton, RadioRow, Separator, TextButton } from './ui';

type Door =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'off' }
  | { kind: 'on'; google: ReceptionGoogle; calendars: ReceptionCalendar[]; events: ReceptionEvent[] };

function eventTime(start: string | null): string {
  return start && start.includes('T') && !Number.isNaN(new Date(start).getTime()) ? hourMinute(new Date(start)) : '終日';
}

export function ReceptionGoogleSection() {
  const [door, setDoor] = useState<Door>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const google = await repositories.reception.getGoogle();
      if (!google.configured) {
        setDoor({ kind: 'off' });
        return;
      }
      const calendars = await repositories.reception.listGoogleCalendars();
      // 予定が読めなくても、カレンダーの選び直しとログアウトはできるようにする
      const events = await repositories.reception.listGoogleEvents().catch(() => []);
      setDoor({ kind: 'on', google, calendars, events });
    } catch (e) {
      // 503 は Google 側が読めない（ログインが切れた、まだログインしていない）。つなぎ直せば直る
      if (e instanceof ApiError && e.status === 503) setDoor({ kind: 'off' });
      else setDoor({ kind: 'error', message: errorMessage(e) ?? '接続できません' });
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      Alert.alert(failure, errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  const login = () =>
    run(async () => {
      const url = await repositories.reception.startGoogleLogin();
      // 戻り先はバックエンドが決める。ブラウザが閉じたら接続の状態を読み直す
      await WebBrowser.openBrowserAsync(url);
    }, 'ログインできませんでした');

  return (
    <>
      <GroupHeader title="受付での照合" />
      {door.kind === 'loading' ? (
        <Card>
          <View style={styles.loading}>
            <ActivityIndicator color={colors.navy} />
          </View>
        </Card>
      ) : door.kind === 'error' ? (
        <>
          <Card>
            <InfoRow label="状態" value="接続できません" />
            <Separator />
            <Text style={styles.message}>{door.message}</Text>
          </Card>
          <View style={styles.actions}>
            <TextButton
              label="もう一度読み込む"
              onPress={() => {
                setDoor({ kind: 'loading' });
                load();
              }}
            />
          </View>
        </>
      ) : door.kind === 'off' ? (
        <>
          <Card>
            <InfoRow label="状態" value="未接続" />
          </Card>
          <View style={styles.actions}>
            <PrimaryButton label="Google でログイン" loading={busy} onPress={login} />
          </View>
        </>
      ) : (
        <>
          <Card>
            <InfoRow label="状態" value="接続済み" />
          </Card>

          <GroupHeader title="照合するカレンダー" />
          <Card>
            {door.calendars.map((calendar, index) => (
              <Fragment key={calendar.id}>
                {index > 0 ? <Separator /> : null}
                <RadioRow
                  label={calendar.summary || calendar.id}
                  selected={door.google.calendar_id === calendar.id}
                  onPress={() =>
                    busy ? undefined : run(() => repositories.reception.selectGoogleCalendar(calendar.id), '変更できませんでした')
                  }
                />
              </Fragment>
            ))}
          </Card>

          <GroupHeader title="今日の予定" />
          <Card>
            {door.events.length === 0 ? (
              <Text style={styles.message}>今日の予定はありません</Text>
            ) : (
              door.events.map((event, index) => (
                <Fragment key={`${event.start ?? 'allday'}-${index}`}>
                  {index > 0 ? <Separator /> : null}
                  <View style={styles.eventRow}>
                    <Text style={styles.eventTime}>{eventTime(event.start)}</Text>
                    <Text style={[styles.eventName, !event.eligible && styles.muted]} numberOfLines={1}>
                      {event.name}
                    </Text>
                    {event.eligible ? null : (
                      <View style={styles.badgeBox}>
                        <IntentBadge label="照合しない" />
                      </View>
                    )}
                  </View>
                </Fragment>
              ))
            )}
          </Card>

          <View style={styles.actions}>
            <TextButton
              label="接続を解除"
              disabled={busy}
              onPress={() =>
                confirmAction({
                  title: '受付での Google の接続を解除しますか',
                  confirmLabel: '解除',
                  cancelLabel: '戻る',
                  onConfirm: () => run(() => repositories.reception.logoutGoogle(), '解除できませんでした'),
                })
              }
            />
          </View>
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loading: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  actions: { marginTop: 16, marginHorizontal: 16, gap: 8 },
  message: { paddingVertical: 14, paddingHorizontal: 16, fontSize: 15, lineHeight: 22, color: colors.textTertiary },
  eventRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  eventTime: { width: 52, fontSize: 17, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  eventName: { flex: 1, fontSize: 17, color: colors.text },
  muted: { color: colors.textSecondary },
  // 札は既定で上に寄るので、行の中央に置く
  badgeBox: { alignSelf: 'center' },
});
