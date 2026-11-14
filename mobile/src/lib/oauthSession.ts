import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

// 連携先の同意画面を開き、戻り先（returnUrl）に戻ってきた URL の問い合わせを返す。閉じたときは null。
// Web 版は同じタブで移るので、ここには戻らない（oauthSession.web.ts）
export async function openOAuthSession(url: string, returnUrl: string): Promise<Record<string, unknown> | null> {
  const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
  if (result.type !== 'success') return null;
  return Linking.parse(result.url).queryParams ?? {};
}

// ネイティブでは、戻り先の問い合わせは openOAuthSession が返す。画面の URL からは読まない
export const OAUTH_RETURNS_TO_PAGE = false;
