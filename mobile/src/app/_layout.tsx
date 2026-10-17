import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '../lib/auth';
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
        <StatusBar style="dark" />
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const { ready, session, household } = useAuth();
  const pendingInvite = usePendingInvite();
  const signedIn = !!session;
  const member = signedIn && !!household;

  usePushNotifications(member ? session.user.id : null);

  // ログイン前に招待リンクを開いていたら、ログイン後に参加の確認へ進む
  useEffect(() => {
    if (ready && signedIn && pendingInvite) {
      router.push({ pathname: '/join', params: { token: pendingInvite } });
    }
  }, [ready, signedIn, pendingInvite]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  // 状態ごとの最初の画面。開けない画面に来たときはここへ移す（指定しないとファイル名の並びで選ばれる）
  const home = member ? '/' : signedIn ? '/group-setup' : '/login';

  // 画面は必ずどれかのガードに入れる
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={member} redirectTo={home}>
        <Stack.Screen name="index" />
        <Stack.Screen name="visits/[id]" />
        <Stack.Screen name="settings/index" />
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
  );
}
