import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { People } from '../components/icons';
import { BackgroundShapes } from '../components/Screen';
import { CenterMessage, PrimaryButton, TextButton } from '../components/ui';
import { acceptInvite, getInvitePreview } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/authActions';
import { setPendingInvite } from '../lib/pendingInvite';
import type { InvitePreview } from '../lib/types';
import { colors } from '../theme';

// 招待リンク（tka2601://join?token=...）か QR コードから開く。ログイン後だけ開ける
export default function JoinScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { refreshMembership } = useAuth();
  const [preview, setPreview] = useState<InvitePreview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPendingInvite(null);
    if (!token) return;
    getInvitePreview(token)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [token]);

  async function join() {
    if (!token) return;
    setBusy(true);
    try {
      await acceptInvite(token);
      await refreshMembership();
      router.replace('/');
    } catch (error) {
      Alert.alert('参加できませんでした', errorMessage(error) ?? '');
    } finally {
      setBusy(false);
    }
  }

  function decline() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  if (!token || preview === null) {
    return (
      <View style={styles.screen}>
        <BackgroundShapes />
        <CenterMessage>招待が見つかりません</CenterMessage>
        <View style={[styles.actions, { paddingHorizontal: 24, paddingBottom: insets.bottom + 40 }]}>
          <TextButton label="戻る" onPress={decline} />
        </View>
      </View>
    );
  }

  if (preview === undefined) {
    return (
      <View style={styles.screen}>
        <BackgroundShapes />
        <CenterMessage>
          <ActivityIndicator color={colors.navy} />
        </CenterMessage>
      </View>
    );
  }

  return (
    <View style={[styles.screen, styles.layout, { paddingTop: insets.top + 93 }]}>
      <BackgroundShapes />
      <View style={styles.body}>
        <View style={styles.iconCircle}>
          <People />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          {`グループ「${preview.household_name}」に\n参加しますか`}
        </Text>
        {preview.inviter_name ? <Text style={styles.inviter}>{`${preview.inviter_name} さんからの招待`}</Text> : null}
      </View>
      <View style={styles.actions}>
        <PrimaryButton label="参加する" loading={busy} onPress={join} />
        <TextButton label="参加しない" onPress={decline} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  layout: { paddingHorizontal: 24, paddingBottom: 150, justifyContent: 'space-between' },
  body: { alignItems: 'center', gap: 16 },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 26, fontWeight: '700', lineHeight: 35, textAlign: 'center', color: colors.text },
  inviter: { fontSize: 15, color: colors.textSecondary },
  actions: { gap: 12, paddingHorizontal: 0 },
});
