import { router } from 'expo-router';
import { useEffect } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { NavBar, Screen } from '../../components/Screen';
import { LargeTitle, PrimaryButton, TextButton, TextField } from '../../components/ui';
import { normalizePairingCode } from '../../domain/devicePairing';
import { useHousehold } from '../../lib/auth';
import { useDeviceGate } from '../../lib/deviceGate';
import { useDeviceClaim } from '../../lib/useDeviceClaim';
import { radius } from '../../theme';

export default function OnboardingCodeScreen() {
  const household = useHousehold();
  const { refresh } = useDeviceGate();
  const claim = useDeviceClaim(household.id, () => void refresh());
  const { device } = claim;

  // 登録できた（または、すでに本体がある）ら、本体の接続待ちへ進む
  useEffect(() => {
    if (device) router.replace('/onboarding/chime');
  }, [device]);

  const error = claim.codeRejected ? 'コードが正しくありません' : claim.error;
  // 結果が分からないときは、コードを送り直さず本体の確認だけをする
  const recheck = claim.claimedId || claim.claimPending || (claim.error && !claim.code && !claim.codeRejected);

  return (
    <Screen>
      <NavBar backLabel="戻る" onBack={() => router.back()} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <LargeTitle title="本体を登録" />
          <View style={styles.section}>
            <TextField
              label="登録コード"
              value={claim.code}
              onChangeText={claim.setCode}
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              maxLength={24}
              editable={!claim.saving}
              placeholder="ABCD-2345"
              style={styles.code}
              error={error}
              onSubmitEditing={() => void claim.claim()}
            />
            <PrimaryButton
              label="このお店に本体を登録"
              loading={claim.saving}
              disabled={!normalizePairingCode(claim.code) || claim.loading || !!claim.claimedId || claim.claimPending}
              onPress={() => void claim.claim()}
            />
            {recheck ? (
              <TextButton
                label="本体情報を再確認"
                disabled={claim.loading || claim.saving}
                onPress={() => void claim.reload(claim.claimedId ?? undefined)}
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: 24, paddingBottom: 40 },
  section: {
    marginHorizontal: 16,
    padding: 16,
    paddingVertical: 20,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.section,
    gap: 14,
  },
  code: { letterSpacing: 1 },
});
