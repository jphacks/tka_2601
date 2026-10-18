import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar, Screen } from '../components/Screen';
import { PrimaryButton, TextField } from '../components/ui';
import { signUpWithEmail } from '../lib/authActions';
import { errorMessage } from '../lib/errors';
import { colors } from '../theme';

// デザインにない画面。ログイン画面と同じ部品で組む
export default function SignUpScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const { needsConfirmation } = await signUpWithEmail(name.trim(), email.trim(), password);
      if (needsConfirmation) {
        Alert.alert('確認のメールを送りました', 'メールのリンクを開いてから、ログインしてください。', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (message) Alert.alert('アカウントを作成できませんでした', message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <NavBar backLabel="ログイン" onBack={() => router.back()} />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title} accessibilityRole="header">
            アカウントを作成
          </Text>
          <View style={styles.form}>
            <TextField label="名前" value={name} onChangeText={setName} placeholder="山田 太郎" textContentType="name" autoComplete="name" />
            <TextField
              label="メールアドレス"
              value={email}
              onChangeText={setEmail}
              placeholder="name@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
            />
            <TextField
              label="パスワード"
              value={password}
              onChangeText={setPassword}
              placeholder="パスワード"
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
            />
            <PrimaryButton
              label="アカウントを作成"
              loading={busy}
              disabled={!name.trim() || !email.trim() || !password}
              onPress={submit}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: 0, paddingBottom: 40, gap: 24 },
  title: { paddingHorizontal: 20, fontSize: 34, fontWeight: '700', color: colors.text },
  form: { paddingHorizontal: 24, gap: 16 },
});
