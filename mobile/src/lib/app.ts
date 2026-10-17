import * as Linking from 'expo-linking';

export const APP_NAME = 'MONBAN';

// 招待リンク。開くと参加の確認画面（/join）に進む。スキームは app.json の scheme
export function inviteLink(token: string): string {
  return Linking.createURL('join', { queryParams: { token } });
}

// QR コードや招待リンク（tka2601://join?token=...、/join?token=...）から招待のトークンを取り出す
export function inviteTokenFromUrl(url: string): string | null {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\/?(?:[^?#]*\/)?join\?(?:[^#]*&)?token=([^&#]+)/i.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}
