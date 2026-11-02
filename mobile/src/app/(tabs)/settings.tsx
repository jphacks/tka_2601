import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check } from '../../components/icons';
import { ConfirmDialog } from '../../components/overlays';
import { Screen } from '../../components/Screen';
import { Card, GroupHeader, LinkRow, Separator, Toggle } from '../../components/ui';
import type { Device, DevicePatch } from '../../domain/device';
import type { ShopProfile } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { deleteAccount } from '../../lib/authActions';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { logout } from '../../lib/logout';
import { BUSINESS_TYPE_LABELS, MODE_LABELS, MODE_ORDER, PROVIDER_LABELS, TONE_LABELS } from '../../lib/labels';
import { colors } from '../../theme';

export default function SettingsScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [serviceCount, setServiceCount] = useState<number | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      repositories.devices
        .get(household.id)
        .then(setDevice)
        .catch((e) => {
          setDevice(null);
          Alert.alert('設定を読み込めませんでした', errorMessage(e) ?? '');
        });
      repositories.shop
        .getProfile(household.id)
        .then(setProfile)
        .catch(() => setProfile(null));
      repositories.shop
        .listServices(household.id)
        .then((services) => setServiceCount(services.length))
        .catch(() => setServiceCount(null));
      repositories.groups
        .listMembers()
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
      await repositories.devices.update(device.id, patch);
    } catch (e) {
      setDevice(previous);
      Alert.alert('変更できませんでした', errorMessage(e) ?? '');
    }
  }

  async function removeAccount() {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await deleteAccount();
    } catch (e) {
      Alert.alert('アカウントを削除できませんでした', errorMessage(e) ?? '');
      setDeleting(false);
    }
  }

  return (
    <Screen waves={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        <View style={styles.topBar} />
        <Text style={styles.largeTitle} accessibilityRole="header">
          設定
        </Text>

        <Text style={styles.firstHeader} accessibilityRole="header">
          動作モード
        </Text>
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

        <GroupHeader title="お店" />
        <Card>
          <LinkRow
            label="店舗情報"
            value={profile ? BUSINESS_TYPE_LABELS[profile.business_type] : undefined}
            onPress={() => router.push('/settings/shop')}
          />
          <Separator />
          <LinkRow
            label="メニュー"
            value={serviceCount !== null ? `${serviceCount}件` : undefined}
            onPress={() => router.push('/settings/services')}
          />
          <Separator />
          <LinkRow
            label="受け答え"
            value={profile ? TONE_LABELS[profile.tone] : undefined}
            onPress={() => router.push('/settings/responses')}
          />
          <Separator />
          <LinkRow
            label="予約先"
            value={profile ? PROVIDER_LABELS[profile.reservation_provider] : undefined}
            onPress={() => router.push('/settings/provider')}
          />
          <Separator />
          <LinkRow label="通知" onPress={() => router.push('/settings/notifications')} />
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

        <GroupHeader title="メンバー" />
        <Card>
          <LinkRow
            label={household.name}
            value={memberCount !== null ? `${memberCount}人` : undefined}
            onPress={() => router.push('/settings/group')}
          />
        </Card>

        <Card style={styles.logoutCard}>
          <Pressable
            onPress={() => logout()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logout, pressed && styles.rowPressed]}
          >
            <Text style={styles.logoutLabel}>ログアウト</Text>
          </Pressable>
          <Separator />
          <Pressable
            onPress={() => setConfirmDelete(true)}
            disabled={deleting}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logout, pressed && styles.rowPressed, deleting && styles.dim]}
          >
            <Text style={styles.logoutLabel}>アカウントを削除</Text>
          </Pressable>
        </Card>
      </ScrollView>
      <ConfirmDialog
        visible={confirmDelete}
        title="アカウントを削除しますか"
        confirmLabel="削除"
        onConfirm={removeAccount}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { height: 44 },
  largeTitle: { paddingHorizontal: 20, paddingBottom: 4, fontSize: 34, fontWeight: '700', color: colors.text },
  firstHeader: {
    paddingTop: 16,
    paddingHorizontal: 32,
    paddingBottom: 7,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
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
  logoutCard: { marginTop: 24 },
  logout: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  logoutLabel: { fontSize: 17, color: colors.navy },
  dim: { opacity: 0.5 },
});
