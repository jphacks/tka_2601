import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../../components/Icon';
import { Screen } from '../../components/Screen';
import { Card, GroupHeader, LargeTitle, LinkRow, RadioRow, RowSwitch, Separator, SettingIcon } from '../../components/ui';
import type { Device, DevicePatch } from '../../domain/device';
import type { ProviderState } from '../../domain/reservation';
import type { ShopProfile } from '../../domain/shop';
import { PRIVACY_POLICY_URL } from '../../lib/app';
import { useHousehold } from '../../lib/auth';
import { deleteAccount } from '../../lib/authActions';
import { confirmAction } from '../../lib/confirm';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { features } from '../../lib/features';
import { integrationRoute, integrationStatus, type Integration, visibleIntegrations } from '../../lib/integrations';
import { logout } from '../../lib/logout';
import { BUSINESS_TYPE_LABELS, MODE_LABELS, MODE_ORDER, PROVIDER_LABELS, TONE_LABELS } from '../../lib/labels';
import { MODE_SYMBOLS, SYMBOLS, type SymbolName } from '../../lib/symbols';
import { colors } from '../../theme';

// 左に札を置く行の区切り線の字下げ
const ICON_INSET = 56;

const INTEGRATION_SYMBOLS: Record<Integration, SymbolName> = {
  google_calendar: SYMBOLS.calendar,
  square: SYMBOLS.card,
  hotpepper: SYMBOLS.scissors,
};

export default function SettingsScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [deviceFailed, setDeviceFailed] = useState(false);
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [providers, setProviders] = useState<ProviderState | null>(null);
  const [serviceCount, setServiceCount] = useState<number | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setDevice(undefined);
      setDeviceFailed(false);
      repositories.devices
        .get(household.id)
        .then((current) => { if (active) setDevice(current); })
        .catch((e) => {
          if (!active) return;
          setDeviceFailed(true);
          Alert.alert('設定を読み込めませんでした', errorMessage(e) ?? '');
        });
      repositories.shop
        .getProfile(household.id)
        .then(setProfile)
        .catch(() => setProfile(null));
      repositories.providers
        .getState()
        .then(setProviders)
        .catch(() => setProviders(null));
      repositories.shop
        .listServices(household.id)
        .then((services) => setServiceCount(services.length))
        .catch(() => setServiceCount(null));
      repositories.groups
        .listMembers()
        .then((members) => setMemberCount(members.length))
        .catch(() => setMemberCount(null));
      return () => { active = false; };
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
    setDeleting(true);
    try {
      await deleteAccount();
    } catch (e) {
      Alert.alert('アカウントを削除できませんでした', errorMessage(e) ?? '');
      setDeleting(false);
    }
  }

  const connections = visibleIntegrations(providers, features.externalProviders);

  return (
    <Screen waves={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        <LargeTitle title="設定" />

        <GroupHeader title="本体" />
        <Card>
          <LinkRow
            label={device ? '登録済みの本体' : deviceFailed ? '本体情報を再確認' : '本体を登録'}
            value={device?.name ?? undefined}
            onPress={() => router.push('/settings/device-pairing')}
          />
          <LinkRow label="プッシャー設定" icon={SYMBOLS.service} onPress={() => router.push('/settings/pusher-settings')} />
        </Card>

        <GroupHeader title="動作モード" />
        <Card>
          {device ? (
            MODE_ORDER.map((mode, index) => (
              <Fragment key={mode}>
                {index > 0 ? <Separator inset={ICON_INSET} /> : null}
                <RadioRow
                  label={MODE_LABELS[mode]}
                  icon={MODE_SYMBOLS[mode]}
                  selected={device.mode === mode}
                  onPress={() => change({ mode })}
                />
              </Fragment>
            ))
          ) : (
            <View style={styles.modeRow}>
              <Text style={styles.muted}>{deviceFailed ? '本体情報を読み込めませんでした' : device === null ? '本体が登録されていません' : '読み込み中'}</Text>
            </View>
          )}
        </Card>

        <GroupHeader title="お店" />
        <Card>
          <LinkRow
            label="店舗情報"
            icon={SYMBOLS.shop}
            value={profile ? BUSINESS_TYPE_LABELS[profile.business_type] : undefined}
            onPress={() => router.push('/settings/shop')}
          />
          <Separator inset={ICON_INSET} />
          <LinkRow
            label="メニュー"
            icon={SYMBOLS.list}
            value={serviceCount !== null ? `${serviceCount}件` : undefined}
            onPress={() => router.push('/settings/services')}
          />
          <Separator inset={ICON_INSET} />
          <LinkRow
            label="受け答え"
            icon={SYMBOLS.bubbles}
            value={profile ? TONE_LABELS[profile.tone] : undefined}
            onPress={() => router.push('/settings/responses')}
          />
          <Separator inset={ICON_INSET} />
          {features.reception ? (
            <>
              <LinkRow label="受付" icon={SYMBOLS.door} onPress={() => router.push('/settings/reception')} />
              <Separator inset={ICON_INSET} />
            </>
          ) : null}
          <LinkRow label="通知" icon={SYMBOLS.bell} onPress={() => router.push('/settings/notifications')} />
        </Card>

        {connections.length > 0 ? (
          <>
            <GroupHeader title="連携" />
            <Card>
              {connections.map((integration, index) => (
                <Fragment key={integration}>
                  {index > 0 ? <Separator inset={ICON_INSET} /> : null}
                  <LinkRow
                    label={PROVIDER_LABELS[integration]}
                    icon={INTEGRATION_SYMBOLS[integration]}
                    value={providers ? integrationStatus(providers, integration) : undefined}
                    onPress={() => router.push(integrationRoute(integration))}
                  />
                </Fragment>
              ))}
            </Card>
          </>
        ) : null}

        <GroupHeader title="外出モード" />
        <Card>
          <View style={styles.switchRow}>
            <SettingIcon name={SYMBOLS.parcel} />
            <Text style={styles.switchLabel}>置き配を頼む</Text>
            <RowSwitch
              accessibilityLabel="置き配を頼む"
              value={device?.away_leave_at_door ?? false}
              disabled={!device}
              onValueChange={(next) => change({ away_leave_at_door: next })}
            />
          </View>
        </Card>

        <GroupHeader title="メンバー" />
        <Card>
          <LinkRow
            label={household.name}
            icon={SYMBOLS.people}
            value={memberCount !== null ? `${memberCount}人` : undefined}
            onPress={() => router.push('/settings/group')}
          />
        </Card>

        <GroupHeader title="このアプリについて" />
        <Card>
          <LinkRow
            label="プライバシーポリシー"
            icon={SYMBOLS.privacy}
            onPress={() => WebBrowser.openBrowserAsync(PRIVACY_POLICY_URL)}
          />
        </Card>

        <Card style={styles.logoutCard}>
          <Pressable
            onPress={() => logout()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logout, pressed && styles.rowPressed]}
          >
            <Icon name={SYMBOLS.logout} size={20} />
            <Text style={styles.logoutLabel}>ログアウト</Text>
          </Pressable>
          <Separator inset={0} />
          <Pressable
            onPress={() =>
              confirmAction({ title: 'アカウントを削除しますか', confirmLabel: '削除', onConfirm: removeAccount })
            }
            disabled={deleting}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logout, pressed && styles.rowPressed, deleting && styles.dim]}
          >
            <Icon name={SYMBOLS.trash} size={20} />
            <Text style={styles.logoutLabel}>アカウントを削除</Text>
          </Pressable>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modeRow: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 16 },
  rowPressed: { backgroundColor: colors.separator },
  muted: { fontSize: 17, color: colors.textSecondary },
  switchRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 16,
  },
  switchLabel: { flex: 1, fontSize: 17, color: colors.text },
  logoutCard: { marginTop: 24 },
  logout: { minHeight: 52, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  logoutLabel: { fontSize: 17, color: colors.navy },
  dim: { opacity: 0.5 },
});
