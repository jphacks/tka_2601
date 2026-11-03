import '../lib/webPolyfills';

import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Screen } from '../components/Screen';
import { WebShell } from '../components/WebShell';
import { PrimaryButton, TextButton } from '../components/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { BadgeProvider } from '../lib/badges';
import { logout } from '../lib/logout';
import { usePendingInvite } from '../lib/pendingInvite';
import { usePushNotifications } from '../lib/push';
import { colors } from '../theme';

// ログイン状態と所属グループを読み終えるまで、起動画面を出したままにする
SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ fade: true, duration: 300 });

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <BadgeProvider>
          <StatusBar style="dark" />
          <RootNavigator />
        </BadgeProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

// 所属を読めないときの画面。通信の失敗で、お店の作成画面へ移さない
function MembershipRetry() {
  const { refreshMembership } = useAuth();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    await refreshMembership();
    setBusy(false);
  }

  return (
    <Screen>
      <View style={styles.retry}>
        <Text style={styles.retryTitle} accessibilityRole="header">
          読み込めませんでした
        </Text>
        <PrimaryButton label="再試行" loading={busy} onPress={retry} />
        <TextButton label="ログアウト" disabled={busy} onPress={() => logout()} />
      </View>
    </Screen>
  );
}

function RootNavigator() {
  const { ready, session, household, membershipFailed } = useAuth();
  const pendingInvite = usePendingInvite();
  const signedIn = !!session;
  const member = signedIn && !!household;

  usePushNotifications(member ? session.user.id : null);

  // ログイン前に招待リンクを開いていたら、ログイン後に参加の確認へ進む
  useEffect(() => {
    if (ready && signedIn && !membershipFailed && pendingInvite) {
      router.push({ pathname: '/join', params: { token: pendingInvite } });
    }
  }, [ready, signedIn, membershipFailed, pendingInvite]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  if (signedIn && !household && membershipFailed) return <MembershipRetry />;

  // 状態ごとの最初の画面。開けない画面に来たときはここへ移す（指定しないとファイル名の並びで選ばれる）
  const home = member ? '/' : signedIn ? '/group-setup' : '/login';

  // 画面は必ずどれかのガードに入れる
  return (
    <WebShell show={member}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Protected guard={member} redirectTo={home}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="visits/[id]" />
          <Stack.Screen name="reservations/[id]" />
          <Stack.Screen name="reservations/edit" />
          <Stack.Screen name="assistant/index" />
          <Stack.Screen name="settings/shop" />
          <Stack.Screen name="settings/services" />
          <Stack.Screen name="settings/service" />
          <Stack.Screen name="settings/responses" />
          <Stack.Screen name="settings/integrations/[provider]" />
          <Stack.Screen name="settings/reception" />
          <Stack.Screen name="settings/guidance" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="settings/instructions" />
          <Stack.Screen name="settings/group" />
          <Stack.Screen name="settings/invite" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && !household} redirectTo={home}>
          <Stack.Screen name="group-setup" />
          <Stack.Screen name="scan" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn} redirectTo={home}>
          <Stack.Screen name="join" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn} redirectTo={home}>
          <Stack.Screen name="login" />
          <Stack.Screen name="signup" />
        </Stack.Protected>
      </Stack>
    </WebShell>
  );
}

const styles = StyleSheet.create({
  retry: { flex: 1, justifyContent: 'center', paddingHorizontal: 16, gap: 12 },
  retryTitle: { paddingBottom: 12, textAlign: 'center', fontSize: 20, fontWeight: '700', color: colors.text },
});
