// Web ではプッシュ通知を使わない（通知の一覧は画面から読む）
export function usePushNotifications(_userId: string | null) {}

export async function unregisterPushToken(_userId: string): Promise<void> {}
