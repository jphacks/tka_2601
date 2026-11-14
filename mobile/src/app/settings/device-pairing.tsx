import { router } from 'expo-router';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, GroupHeader, InfoRow, PrimaryButton, TextButton, TextField } from '../../components/ui';
import { normalizePairingCode } from '../../domain/devicePairing';
import { useHousehold } from '../../lib/auth';
import { useDeviceGate } from '../../lib/deviceGate';
import { useDeviceClaim } from '../../lib/useDeviceClaim';
import { colors } from '../../theme';

export default function DevicePairingScreen() {
  const household = useHousehold();
  return <DevicePairingForm key={household.id} />;
}

function DevicePairingForm() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const { refresh } = useDeviceGate();
  // 本体が登録されたら、アプリ全体の本体の有無も読み直す
  const { device, code, setCode, loading, saving, error, claimedId, claimPending, claim, reload: load } = useDeviceClaim(
    household.id,
    () => void refresh(),
  );

  return (
    <Screen waves={false}>
      <NavBar title="本体の登録" backLabel="設定" onBack={() => router.back()} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          <GroupHeader title={household.name} first />
          {loading ? <ActivityIndicator accessibilityLabel="本体情報を読み込み中" style={styles.space} /> : null}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {device ? (
            <>
              <Card>
                <InfoRow label="本体" value={device.name || 'MONBAN'} />
                <InfoRow label="登録先" value={household.name} />
                <InfoRow label="登録状態" value="登録済み" />
              </Card>
              <Text style={styles.note}>本体の登録と、Wi-Fi接続・設定の反映は別の状態です。</Text>
              <View style={styles.actions}><PrimaryButton label="設定へ戻る" onPress={() => router.replace('/(tabs)/settings')} /></View>
            </>
          ) : claimedId || claimPending ? (
            <View style={styles.actions}>
              <Text style={styles.note}>{claimedId ? '登録は受け付けられました。本体情報の確認を続けてください。' : '登録結果が未確認です。再登録の前に本体情報を確認してください。'}</Text>
              <PrimaryButton label="本体情報を再確認" loading={loading} onPress={() => void load(claimedId ?? undefined)} />
            </View>
          ) : error && !code ? (
            <View style={styles.actions}><PrimaryButton label="再試行" loading={loading} onPress={() => void load()} /></View>
          ) : !loading ? (
            <View style={styles.actions}>
              <Text style={styles.note}>本体のセットアップ時に発行された8文字のペアリングコードを入力してください。</Text>
              <TextField label="ペアリングコード" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} spellCheck={false} maxLength={24} editable={!saving} placeholder="ABCD-2345" onSubmitEditing={() => void claim()} />
              <PrimaryButton label="このお店に本体を登録" loading={saving} disabled={!normalizePairingCode(code)} onPress={() => void claim()} />
              {error ? <TextButton label="本体情報を再確認" disabled={saving} onPress={() => void load()} /> : null}
              <Text style={styles.note}>コードが手元にない場合は、セットアップ担当者に確認してください。</Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  actions: { paddingHorizontal: 16, gap: 16 },
  note: { marginHorizontal: 16, marginVertical: 12, fontSize: 15, lineHeight: 22, color: colors.textSecondary },
  error: { margin: 16, fontSize: 16, lineHeight: 24, color: colors.text },
  space: { margin: 24 },
});
