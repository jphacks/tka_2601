import { Alert } from 'react-native';

import { PushCleanupFailed, signOut } from './authActions';
import { errorMessage } from './errors';

// ログアウトする。端末を通知の送り先から外せないときは、確かめてから抜ける
export async function logout(keepPushToken = false): Promise<void> {
  try {
    await signOut({ keepPushToken });
  } catch (e) {
    if (e instanceof PushCleanupFailed) {
      Alert.alert('通知の設定を解除できませんでした', 'ログアウトしても、この端末に通知が届くことがあります。', [
        { text: '戻る', style: 'cancel' },
        { text: 'ログアウト', style: 'destructive', onPress: () => logout(true) },
      ]);
      return;
    }
    Alert.alert('ログアウトできませんでした', errorMessage(e) ?? '');
  }
}
