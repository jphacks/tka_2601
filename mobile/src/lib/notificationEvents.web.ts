// Web にはプッシュ通知がないので、通知の読み取り（NotificationToast）が新着を見つけたときに知らせる
const listeners = new Set<() => void>();

export function onNotificationReceived(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitNotificationReceived(): void {
  listeners.forEach((listener) => listener());
}
