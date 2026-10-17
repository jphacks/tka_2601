import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '../lib/auth';
import { usePendingInvite } from '../lib/pendingInvite';
import { usePushNotifications } from '../lib/push';
import { colors } from '../theme';

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

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  // 画面は必ずどれかのガードに入れる。開けない画面に来たときは、開けるもののうち先頭に移る
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={member}>
        <Stack.Screen name="index" />
        <Stack.Screen name="visits/[id]" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/instructions" />
        <Stack.Screen name="settings/group" />
        <Stack.Screen name="settings/invite" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !household}>
        <Stack.Screen name="group-setup" />
        <Stack.Screen name="scan" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="join" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
        <Stack.Screen name="signup" />
      </Stack.Protected>
    </Stack>
  );
}
