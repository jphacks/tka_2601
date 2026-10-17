import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { QrScan } from '../components/icons';
import { Screen } from '../components/Screen';
import { PrimaryButton, TextField, TintButton } from '../components/ui';
import { createHousehold } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/authActions';
import { colors, radius } from '../theme';

// 初回: グループを作るか、家族のグループに参加する
export default function GroupSetupScreen() {
  const { refreshMembership } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await createHousehold(name.trim());
      await refreshMembership();
    } catch (error) {
      Alert.alert('グループを作れませんでした', errorMessage(error) ?? '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title} accessibilityRole="header">
            グループを設定する
          </Text>
          <View style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              新しくグループを作る
            </Text>
            <TextField label="グループの名前" value={name} onChangeText={setName} placeholder="山田家" />
            <PrimaryButton label="グループを作る" loading={busy} disabled={!name.trim()} onPress={create} />
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              家族のグループに参加する
            </Text>
            <TintButton label="QR コードを読み取る" icon={<QrScan />} onPress={() => router.push('/scan')} />
          </View>
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
