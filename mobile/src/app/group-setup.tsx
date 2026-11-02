import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { QrScan } from '../components/icons';
import { Screen } from '../components/Screen';
import { PrimaryButton, TextButton, TextField, TintButton } from '../components/ui';
import { useAuth } from '../lib/auth';
import { repositories } from '../lib/container';
import { errorMessage } from '../lib/errors';
import { logout } from '../lib/logout';
import { colors, radius } from '../theme';

// 初回: お店を作るか、招待されたお店に参加する
export default function GroupSetupScreen() {
  const { refreshMembership } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await repositories.groups.create(name.trim());
      await refreshMembership();
    } catch (error) {
      Alert.alert('お店を作れませんでした', errorMessage(error) ?? '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title} accessibilityRole="header">
            お店を設定する
          </Text>
          <View style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              新しくお店を作る
            </Text>
            <TextField label="お店の名前" value={name} onChangeText={setName} placeholder="ネイルサロン ひより" />
            <PrimaryButton label="お店を作る" loading={busy} disabled={!name.trim()} onPress={create} />
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              招待されたお店に参加する
            </Text>
            <TintButton label="QR コードを読み取る" icon={<QrScan />} onPress={() => router.push('/scan')} />
          </View>
          <TextButton label="ログアウト" onPress={() => logout()} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: 44, paddingBottom: 40, gap: 24 },
  title: { paddingHorizontal: 20, fontSize: 34, fontWeight: '700', color: colors.text },
  section: {
    marginHorizontal: 16,
    paddingVertical: 20,
    paddingHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: radius.section,
    gap: 14,
  },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
});
