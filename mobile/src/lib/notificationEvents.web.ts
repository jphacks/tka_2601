// Web にはプッシュ通知がないので、何も受けない
export function onNotificationReceived(_listener: () => void): () => void {
  return () => undefined;
}
