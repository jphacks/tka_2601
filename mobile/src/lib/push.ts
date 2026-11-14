import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { notificationTarget } from '../domain/notification';
import { repositories } from './container';
import { INTEGRATION_ERROR_ROUTE } from './integrations';

// アプリを開いているあいだに届いた通知も、バナーで出す
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registeredToken: string | null = null;

// EAS のプロジェクト ID（npx eas-cli init で app.json の extra.eas.projectId に入る）
function easProjectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

async function requestExpoPushToken(): Promise<string | null> {
  const projectId = easProjectId();
  if (!projectId) {
    console.warn('EAS の projectId がないため、通知のトークンを取れません（npx eas-cli init を実行してください）');
    return null;
  }
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

// グループに入っているメンバーの端末を通知の送り先に登録し、通知を押したら予約か来客の詳細を開く
export function usePushNotifications(userId: string | null) {
  const response = Notifications.useLastNotificationResponse();
  const handledResponse = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    requestExpoPushToken()
      .then(async (token) => {
        if (!token || cancelled) return;
        await repositories.pushTokens.save(userId, token);
        registeredToken = token;
      })
      .catch((error) => console.warn('通知の登録に失敗しました', error));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId || !response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handledResponse.current === id) return;
    handledResponse.current = id;
    const content = response.notification.request.content.data ?? {};
    const target = notificationTarget(content, typeof content.kind === 'string' ? content.kind : undefined);
    if (target?.type === 'reservation') {
      router.push({ pathname: '/reservations/[id]', params: { id: target.id } });
    } else if (target?.type === 'visit') {
      router.push({ pathname: '/visits/[id]', params: { id: target.id } });
    } else if (target?.type === 'provider') {
      router.push(INTEGRATION_ERROR_ROUTE);
    } else {
      router.push('/notifications');
    }
  }, [userId, response]);
}

// 通知が許可されていれば、この端末のトークンを返す。許可を尋ねない
async function currentExpoPushToken(): Promise<string | null> {
  const projectId = easProjectId();
  if (!projectId || !(await Notifications.getPermissionsAsync()).granted) return null;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

// ログアウトの前に、この端末を送り先から外す。起動時の登録に失敗していても前回の行が残るので、
// 覚えていなければ取り直す。消せなければ例外を投げる
export async function unregisterPushToken(userId: string): Promise<void> {
  const token = registeredToken ?? (await currentExpoPushToken());
  if (!token) return;
  await repositories.pushTokens.remove(userId, token);
  registeredToken = null;
}
