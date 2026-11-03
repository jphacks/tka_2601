import * as Notifications from 'expo-notifications';

// アプリを開いているあいだに通知を受けたときに呼ぶ。外すときの関数を返す
export function onNotificationReceived(listener: () => void): () => void {
  const subscription = Notifications.addNotificationReceivedListener(listener);
  return () => subscription.remove();
}
