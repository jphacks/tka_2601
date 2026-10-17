import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check } from '../../components/icons';
import { NavBar, Screen } from '../../components/Screen';
import { Card, GroupHeader, LinkRow, Separator, Toggle } from '../../components/ui';
import { type DevicePatch, getDevice, listMembers, updateDevice } from '../../lib/api';
import { useHousehold } from '../../lib/auth';
import { errorMessage, signOut } from '../../lib/authActions';
import { MODE_LABELS, MODE_ORDER } from '../../lib/labels';
import type { Device } from '../../lib/types';
import { colors } from '../../theme';

export default function SettingsScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [memberCount, setMemberCount] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      getDevice(household.id)
        .then(setDevice)
        .catch((e) => {
          setDevice(null);
          Alert.alert('設定を読み込めませんでした', errorMessage(e) ?? '');
        });
      listMembers()
        .then((members) => setMemberCount(members.length))
        .catch(() => setMemberCount(null));
    }, [household.id]),
  );

  // 先に画面を変え、保存に失敗したら戻す
  async function change(patch: DevicePatch) {
    if (!device) return;
    const previous = device;
    setDevice({ ...device, ...patch });
    try {
      await updateDevice(device.id, patch);
    } catch (e) {
      setDevice(previous);
      Alert.alert('変更できませんでした', errorMessage(e) ?? '');
    }
  }

  async function logout() {
    try {
      await signOut();
    } catch (e) {
      Alert.alert('ログアウトできませんでした', errorMessage(e) ?? '');
    }
  }

  return (
    <Screen>
      <NavBar title="設定" backLabel="来客" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <GroupHeader title="動作モード" first />
        <Card>
          {device ? (
            MODE_ORDER.map((mode, index) => {
              const selected = device.mode === mode;
              return (
                <Fragment key={mode}>
                  {index > 0 ? <Separator /> : null}
                  <Pressable
                    onPress={() => change({ mode })}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    style={({ pressed }) => [styles.modeRow, pressed && styles.rowPressed]}
                  >
                    <Text style={[styles.modeLabel, selected && styles.modeSelected]}>{MODE_LABELS[mode]}</Text>
                    <View style={styles.checkBox}>{selected ? <Check /> : null}</View>
                  </Pressable>
                </Fragment>
              );
            })
          ) : (
            <View style={styles.modeRow}>
              <Text style={styles.muted}>{device === null ? '本体が登録されていません' : '読み込み中'}</Text>
            </View>
          )}
        </Card>

        <GroupHeader title="外出モード" />
        <Card>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>置き配を頼む</Text>
            <Toggle
              label="置き配を頼む"
              value={device?.away_leave_at_door ?? false}
              disabled={!device}
              onChange={(next) => change({ away_leave_at_door: next })}
            />
          </View>
        </Card>

        <GroupHeader title="モードの自動切替" />
        <Card>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>だれもいないとき外出にする</Text>
            <Toggle
              label="だれもいないとき外出にする"
              value={device?.auto_away ?? false}
              disabled={!device}
              onChange={(next) => change({ auto_away: next })}
            />
          </View>
        </Card>

        <GroupHeader title="AI への指示" />
        <Card>
          <LinkRow
            label="追加の指示"
            value={device?.extra_instructions ? '設定済み' : '未設定'}
            onPress={() => router.push('/settings/instructions')}
          />
        </Card>

        <GroupHeader title="グループ" />
        <Card>
          <LinkRow
            label={household.name}
            value={memberCount !== null ? `${memberCount}人` : undefined}
            onPress={() => router.push('/settings/group')}
          />
        </Card>

        <Card style={styles.logoutCard}>
          <Pressable
            onPress={logout}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logout, pressed && styles.rowPressed]}
          >
            <Text style={styles.logoutLabel}>ログアウト</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 46,
  },
  rowPressed: { backgroundColor: colors.separator },
  modeLabel: { flex: 1, fontSize: 17, color: colors.text },
  modeSelected: { fontWeight: '600' },
  checkBox: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 17, color: colors.textSecondary },
  switchRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  switchLabel: { flex: 1, fontSize: 17, color: colors.text },
  logoutCard: { marginTop: 32 },
  logout: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  logoutLabel: { fontSize: 17, color: colors.navy },
});
