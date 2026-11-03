import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, CenterMessage, GroupHeader, RowSwitch, Separator, SettingIcon } from '../../components/ui';
import {
  groupNotificationKinds,
  type NotificationKind,
  type NotificationPreference,
} from '../../domain/notification';
import { useAuth } from '../../lib/auth';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { notificationCategoryLabel } from '../../lib/labels';
import { notificationSymbol } from '../../lib/symbols';
import { colors } from '../../theme';

// 種類は notification_kinds の表から作る。種類を足してもアプリの更新は要らない
export default function NotificationSettingsScreen() {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const userId = session?.user.id ?? null;
  const [kinds, setKinds] = useState<NotificationKind[] | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      Promise.all([repositories.notifications.listKinds(), repositories.notifications.listPreferences(userId)])
        .then(([nextKinds, nextPreferences]) => {
          setKinds(nextKinds);
          setPreferences(nextPreferences);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e) ?? '読み込めませんでした'));
    }, [userId]),
  );

  // 先に画面を変え、保存に失敗したら戻す
  async function change(kind: string, enabled: boolean) {
    if (!userId) return;
    const previous = preferences;
    setPreferences([...preferences.filter((p) => p.kind !== kind), { kind, enabled }]);
    try {
      await repositories.notifications.savePreference(userId, kind, enabled);
    } catch (e) {
      setPreferences(previous);
      Alert.alert('変更できませんでした', errorMessage(e) ?? '');
    }
  }

  const sections = useMemo(() => groupNotificationKinds(kinds ?? [], preferences), [kinds, preferences]);

  return (
    <Screen>
      <NavBar title="通知" backLabel="設定" onBack={() => router.back()} />
      {kinds === null ? (
        <CenterMessage>{error ?? <ActivityIndicator color={colors.navy} />}</CenterMessage>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          {sections.map((section, sectionIndex) => (
            <Fragment key={section.category}>
              <GroupHeader title={notificationCategoryLabel(section.category)} first={sectionIndex === 0} />
              <Card>
                {section.kinds.map((kind, index) => (
                  <Fragment key={kind.kind}>
                    {index > 0 ? <Separator inset={56} /> : null}
                    <View style={styles.row}>
                      <SettingIcon name={notificationSymbol(kind.kind)} />
                      <Text style={styles.label}>{kind.label}</Text>
                      <RowSwitch
                        accessibilityLabel={kind.label}
                        value={kind.enabled}
                        onValueChange={(next) => change(kind.kind, next)}
                      />
                    </View>
                  </Fragment>
                ))}
              </Card>
            </Fragment>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: 16 },
  label: { flex: 1, fontSize: 17, color: colors.text },
});
