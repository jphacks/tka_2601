import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, CenterMessage, GroupHeader, InfoRow, IntentBadge, LinkRow, Separator, TextButton } from '../../components/ui';
import type { ReceptionVisit } from '../../domain/reception';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { relativeDateTime } from '../../lib/format';
import { colors } from '../../theme';

// 受付の画面に出す、直近のスタッフ確認の件数
const VISIT_LIMIT = 5;

type Loaded = { ready: boolean; guidance: string; visits: ReceptionVisit[] };

export default function ReceptionScreen() {
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ready, guidance, visits] = await Promise.all([
        repositories.reception.isReady(),
        repositories.reception.getGuidance(),
        repositories.reception.listVisits(),
      ]);
      setLoaded({ ready, guidance, visits: visits.slice(0, VISIT_LIMIT) });
      setError(null);
    } catch (e) {
      setLoaded(null);
      setError(errorMessage(e) ?? '受付に接続できません。しばらくしてからやり直してください。');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <Screen>
      <NavBar title="受付" backLabel="設定" onBack={() => router.back()} />
      {error ? (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          <GroupHeader title="状態" first />
          <Card>
            <InfoRow label="受付" value="接続できません" />
            <Separator />
            <Text style={styles.message}>{error}</Text>
          </Card>
          <View style={styles.actions}>
            <TextButton
              label="もう一度読み込む"
              onPress={() => {
                setError(null);
                load();
              }}
            />
          </View>
        </ScrollView>
      ) : !loaded ? (
        <CenterMessage>
          <ActivityIndicator color={colors.navy} />
        </CenterMessage>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          <GroupHeader title="状態" first />
          <Card>
            <InfoRow label="受付" value={loaded.ready ? '利用できます' : '停止中'} />
          </Card>

          <GroupHeader title="案内文" />
          <Card>
            <LinkRow label={loaded.guidance} onPress={() => router.push('/settings/guidance')} />
          </Card>

          <GroupHeader title="最近のスタッフ確認" />
          <Card>
            {loaded.visits.length === 0 ? (
              <Text style={styles.message}>まだありません</Text>
            ) : (
              loaded.visits.map((visit, index) => (
                <Fragment key={`${visit.created}-${index}`}>
                  {index > 0 ? <Separator /> : null}
                  <View style={styles.visitRow}>
                    <View style={styles.visitText}>
                      <Text style={styles.visitName}>{visit.name || '名前なし'}</Text>
                      <Text style={styles.visitMeta}>{`担当 ${visit.staff || 'なし'} ・ ${relativeDateTime(visit.created)}`}</Text>
                      {!visit.staff_notified && visit.notification_reason ? (
                        <Text style={styles.visitMeta}>{`理由 ${visit.notification_reason}`}</Text>
                      ) : null}
                    </View>
                    <View style={styles.badgeBox}>
                      {/* 札は既定で上に寄るので、行の中央に置く */}
                      <IntentBadge label={visit.staff_notified ? '通知済み' : '通知なし'} emphasis={visit.staff_notified} />
                    </View>
                  </View>
                </Fragment>
              ))
            )}
          </Card>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  message: { paddingVertical: 14, paddingHorizontal: 16, fontSize: 15, lineHeight: 22, color: colors.textTertiary },
  actions: { marginTop: 16, marginHorizontal: 16, gap: 8 },
  visitRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16 },
  visitText: { flex: 1 },
  badgeBox: { alignSelf: 'center' },
  visitName: { fontSize: 17, color: colors.text },
  visitMeta: { marginTop: 2, fontSize: 13, color: colors.textSecondary },
});
