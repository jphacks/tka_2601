import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronRight } from '../../components/icons';
import { ConfirmDialog } from '../../components/overlays';
import { NavBar, Screen } from '../../components/Screen';
import { CenterMessage, PrimaryButton, SoftButton } from '../../components/ui';
import {
  addDays,
  customerLabel,
  PENDING_RANGE_DAYS,
  type Reservation,
  type ReservationProvider,
  startOfDayDate,
} from '../../domain/reservation';
import { useBadges } from '../../lib/badges';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { dateTimeRange } from '../../lib/format';
import { approveDialogTitle } from '../../lib/labels';
import { colors, radius } from '../../theme';

type Dialog = { type: 'approve' | 'decline'; reservation: Reservation } | null;

export default function ApprovalsScreen() {
  const insets = useSafeAreaInsets();
  const { refresh: refreshBadges } = useBadges();
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [provider, setProvider] = useState<ReservationProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 処理中の予約。同じ予約を二重に操作させない
  const [processing, setProcessing] = useState<readonly string[]>([]);
  // 続けて操作したとき、遅れて届いた前の一覧で上書きしない
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const today = startOfDayDate(new Date());
      const result = await repositories.reservations.list({ from: today, to: addDays(today, PENDING_RANGE_DAYS) }, 'pending');
      if (current !== request.current) return;
      setRows(result.reservations);
      setProvider(result.provider);
      setError(null);
    } catch (e) {
      if (current === request.current) setError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function run(action: (id: string) => Promise<void>, reservation: Reservation, failure: string) {
    setDialog(null);
    setProcessing((current) => [...current, reservation.id]);
    try {
      await action(reservation.id);
      await load();
      refreshBadges();
    } catch (e) {
      Alert.alert(failure, errorMessage(e) ?? '');
    } finally {
      setProcessing((current) => current.filter((id) => id !== reservation.id));
    }
  }

  return (
    <Screen>
      <NavBar title="承認待ち" backLabel="予約" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} />}
      >
        {error ? (
          <View style={styles.message}>
            <CenterMessage>{error}</CenterMessage>
          </View>
        ) : rows === null ? (
          <View style={styles.message}>
            <ActivityIndicator color={colors.navy} />
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.message}>
            <CenterMessage>承認待ちの予約はありません</CenterMessage>
          </View>
        ) : (
          rows.map((reservation) => {
            const name = customerLabel(reservation);
            const busy = processing.includes(reservation.id);
            return (
              <View key={reservation.id} style={styles.card}>
                <Pressable
                  onPress={() =>
                    router.push({ pathname: '/reservations/[id]', params: { id: reservation.id, back: '承認待ち' } })
                  }
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.head, pressed && styles.pressed]}
                >
                  <View style={styles.body}>
                    <Text style={styles.when}>{dateTimeRange(reservation.starts_at, reservation.ends_at)}</Text>
                    <Text style={styles.name}>{name}</Text>
                    {reservation.service_name ? <Text style={styles.service}>{reservation.service_name}</Text> : null}
                    <Text style={styles.phone}>{reservation.customer_phone ?? '電話番号なし'}</Text>
                  </View>
                  <ChevronRight />
                </Pressable>
                {reservation.read_only ? null : (
                  <View style={styles.actions}>
                    <SoftButton
                      label="お断り"
                      disabled={busy}
                      onPress={() => setDialog({ type: 'decline', reservation })}
                      style={styles.action}
                    />
                    <PrimaryButton
                      label="承認"
                      loading={busy}
                      onPress={() => setDialog({ type: 'approve', reservation })}
                      style={styles.action}
                    />
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
      <ConfirmDialog
        visible={dialog?.type === 'approve'}
        title={approveDialogTitle(provider)}
        confirmLabel="承認"
        cancelLabel="戻る"
        onConfirm={() => dialog && run(repositories.reservations.approve, dialog.reservation, '承認できませんでした')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog?.type === 'decline'}
        title="この予約をお断りしますか"
        confirmLabel="お断り"
        cancelLabel="戻る"
        onConfirm={() => dialog && run(repositories.reservations.cancel, dialog.reservation, 'お断りできませんでした')}
        onCancel={() => setDialog(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingHorizontal: 16, gap: 12 },
  message: { minHeight: 240 },
  card: { padding: 16, gap: 12, borderRadius: radius.section, backgroundColor: colors.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pressed: { opacity: 0.5 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  when: { fontSize: 15, fontWeight: '600', color: colors.navy, fontVariant: ['tabular-nums'] },
  name: { fontSize: 20, lineHeight: 28, fontWeight: '600', color: colors.text },
  service: { fontSize: 15, lineHeight: 22, color: colors.textTertiary },
  phone: { fontSize: 14, lineHeight: 20, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
});
