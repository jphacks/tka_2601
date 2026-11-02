import * as Linking from 'expo-linking';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmDialog } from '../../components/overlays';
import { NavBar, Screen } from '../../components/Screen';
import {
  Card,
  CenterMessage,
  DefinitionList,
  IntentBadge,
  LinkRow,
  NavTextButton,
  PrimaryButton,
  SoftButton,
  TextButton,
} from '../../components/ui';
import { canRecordArrival, customerLabel, type Reservation, type ReservationProvider } from '../../domain/reservation';
import { useBadges } from '../../lib/badges';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { dateTimeRange, hourMinute } from '../../lib/format';
import { approveDialogTitle, reservationBadge, sourceLabel } from '../../lib/labels';
import { colors, radius } from '../../theme';

type Dialog = 'approve' | 'cancel' | null;

export default function ReservationDetailScreen() {
  const { id, back } = useLocalSearchParams<{ id: string; back?: string }>();
  const insets = useSafeAreaInsets();
  const { refresh: refreshBadges } = useBadges();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [provider, setProvider] = useState<ReservationProvider | null>(null);
  const [visitTime, setVisitTime] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await repositories.reservations.get(id);
      setReservation(next);
      setError(null);
      if (next.visit_id) {
        repositories.visits
          .get(next.visit_id)
          .then((found) => {
            if (!found) return setVisitTime(null);
            const date = new Date(found.visit.chimed_at);
            setVisitTime(`${date.getMonth() + 1}月${date.getDate()}日 ${hourMinute(date)}`);
          })
          .catch(() => setVisitTime(null));
      }
    } catch (e) {
      setError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
      repositories.providers
        .getState()
        .then((state) => setProvider(state.provider))
        .catch(() => setProvider(null));
    }, [load]),
  );

  async function run(action: (id: string) => Promise<void>, failure: string) {
    setDialog(null);
    setBusy(true);
    try {
      await action(id);
      await load();
      refreshBadges();
    } catch (e) {
      Alert.alert(failure, errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  const active = reservation && reservation.status !== 'cancelled';
  const badge = reservation ? reservationBadge(reservation) : null;
  const pending = reservation?.status === 'pending';

  return (
    <Screen>
      <NavBar
        title={reservation ? customerLabel(reservation) : undefined}
        backLabel={back ?? '予約'}
        onBack={() => router.back()}
        right={
          active && !reservation.read_only ? (
            <NavTextButton
              label="編集"
              accessibilityLabel="予約を編集"
              onPress={() => router.push({ pathname: '/reservations/edit', params: { id } })}
            />
          ) : null
        }
      />
      {!reservation ? (
        <CenterMessage>{error ?? <ActivityIndicator color={colors.navy} />}</CenterMessage>
      ) : (
        <View style={[styles.flex, { paddingBottom: insets.bottom }]}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
            <View style={styles.summary}>
              <View style={styles.summaryHead}>
                {badge ? <IntentBadge label={badge} emphasis={!!reservation.arrived_at} /> : null}
                <Text style={styles.when}>{dateTimeRange(reservation.starts_at, reservation.ends_at)}</Text>
              </View>
              <View style={styles.divider} />
              <DefinitionList
                rows={[
                  ...(reservation.service_name
                    ? [{ label: 'メニュー', value: reservation.service_name, strong: true }]
                    : []),
                  ...(reservation.customer_phone
                    ? [
                        {
                          label: '電話',
                          value: (
                            <Pressable
                              onPress={() => Linking.openURL(`tel:${reservation.customer_phone}`)}
                              accessibilityRole="link"
                              accessibilityLabel={`電話をかける ${reservation.customer_phone}`}
                            >
                              <Text style={styles.phone}>{reservation.customer_phone}</Text>
                            </Pressable>
                          ),
                        },
                      ]
                    : []),
                  { label: '受付', value: sourceLabel(reservation.source, provider) },
                  ...(reservation.arrived_at
                    ? [{ label: '到着', value: hourMinute(new Date(reservation.arrived_at)) }]
                    : []),
                  ...(reservation.note ? [{ label: 'メモ', value: reservation.note }] : []),
                ]}
              />
            </View>

            {reservation.visit_id ? (
              <Card style={styles.visitCard}>
                <LinkRow
                  label="来客の会話"
                  value={visitTime ?? undefined}
                  onPress={() =>
                    router.push({
                      pathname: '/visits/[id]',
                      params: { id: reservation.visit_id as string, back: back ?? '予約' },
                    })
                  }
                />
              </Card>
            ) : null}
          </ScrollView>

          {active ? (
            <View style={styles.actions}>
              {pending && !reservation.read_only ? (
                <View style={styles.pair}>
                  <SoftButton label="お断り" disabled={busy} onPress={() => setDialog('cancel')} style={styles.flex} />
                  <PrimaryButton label="承認" loading={busy} onPress={() => setDialog('approve')} style={styles.flex} />
                </View>
              ) : null}
              {canRecordArrival(reservation, new Date()) ? (
                <PrimaryButton
                  label="到着を記録"
                  loading={busy}
                  onPress={() => run(repositories.reservations.arrive, '到着を記録できませんでした')}
                />
              ) : null}
              {!pending && !reservation.read_only ? (
                <TextButton label="予約をキャンセル" disabled={busy} onPress={() => setDialog('cancel')} />
              ) : null}
            </View>
          ) : null}
        </View>
      )}
      <ConfirmDialog
        visible={dialog === 'approve'}
        title={approveDialogTitle(provider)}
        confirmLabel="承認"
        cancelLabel="戻る"
        onConfirm={() => run(repositories.reservations.approve, '承認できませんでした')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'cancel'}
        title={pending ? 'この予約をお断りしますか' : 'この予約をキャンセルしますか'}
        confirmLabel={pending ? 'お断り' : 'キャンセルする'}
        cancelLabel="戻る"
        onConfirm={() => run(repositories.reservations.cancel, 'キャンセルできませんでした')}
        onCancel={() => setDialog(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: 8, paddingBottom: 16 },
  summary: { marginHorizontal: 16, padding: 16, gap: 14, borderRadius: radius.section, backgroundColor: colors.card },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  when: { flexShrink: 1, fontSize: 15, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  divider: { height: 1, backgroundColor: colors.separator },
  phone: { fontSize: 15, lineHeight: 22, color: colors.navy, fontVariant: ['tabular-nums'] },
  visitCard: { marginTop: 16 },
  actions: { marginHorizontal: 16, gap: 8 },
  pair: { flexDirection: 'row', gap: 8 },
});
