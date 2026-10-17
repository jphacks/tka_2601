import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { House } from '../components/icons';
import { BackgroundShapes } from '../components/Screen';
import { PrimaryButton, TextField } from '../components/ui';
import { APP_NAME } from '../lib/app';
import { errorMessage, signInWithApple, signInWithEmail, signInWithGoogle } from '../lib/authActions';
import { colors } from '../theme';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'email' | 'apple' | 'google' | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  async function run(kind: 'email' | 'apple' | 'google', action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      const message = errorMessage(error);
      if (message) Alert.alert('ログインできませんでした', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.screen}>
      <BackgroundShapes />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 41 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            <View style={styles.appIcon}>
              <House />
            </View>
            <Text style={styles.appName} accessibilityRole="header">
              {APP_NAME}
            </Text>
          </View>

          <View style={styles.form}>
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
              autoComplete="current-password"
              textContentType="password"
            />
            <PrimaryButton
              label="ログイン"
              loading={busy === 'email'}
              disabled={busy !== null}
              onPress={() => run('email', () => signInWithEmail(email, password))}
            />
            <View style={styles.signupLine}>
              <Text style={styles.signupText}>初めての方は </Text>
              <Pressable
                onPress={() => router.push('/signup')}
                accessibilityRole="link"
                hitSlop={8}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Text style={styles.signupLink}>アカウントを作成</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>または</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={styles.providers}>
            {appleAvailable ? (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={() => run('apple', signInWithApple)}
              />
            ) : null}
            <Pressable
              onPress={() => run('google', signInWithGoogle)}
              disabled={busy !== null}
              accessibilityRole="button"
              style={({ pressed }) => [styles.googleButton, pressed && styles.pressed]}
            >
              <Text style={styles.googleLabel}>Google でログイン</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { paddingHorizontal: 24, paddingBottom: 40, gap: 32 },
  brand: { alignItems: 'center', gap: 12 },
  appIcon: {
    width: 72,
    height: 72,
    borderRadius: 16,
    backgroundColor: colors.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appName: { fontSize: 28, fontWeight: '700', color: colors.text },
  form: { gap: 16 },
  signupLine: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  signupText: { fontSize: 15, color: colors.textSecondary },
  signupLink: { fontSize: 15, fontWeight: '600', color: colors.navy },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 13, color: colors.textSecondary },
  providers: { gap: 12 },
  appleButton: { height: 50 },
  googleButton: {
    height: 50,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleLabel: { fontSize: 17, fontWeight: '600', color: colors.text },
  pressed: { opacity: 0.6 },
});
