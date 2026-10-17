import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { unregisterPushToken } from './push';
import { requireSupabase } from './supabase';

class Cancelled extends Error {}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
}

// 名前は user_metadata.full_name に入れる。グループ画面のメンバー名に使う
export async function signUpWithEmail(
  fullName: string,
  email: string,
  password: string,
): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await requireSupabase().auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function signInWithApple(): Promise<void> {
  const supabase = requireSupabase();
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw new Cancelled();
    throw error;
  }
  if (!credential.identityToken) throw new Error('Apple から本人確認の情報を受け取れませんでした');
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken });
  if (error) throw error;

  // Apple は名前を初回のサインインでしか渡さないので、そのときに保存する
  const { givenName, familyName } = credential.fullName ?? {};
  const fullName = [familyName, givenName].filter(Boolean).join(' ');
  if (fullName) await supabase.auth.updateUser({ data: { full_name: fullName } });
}

// Google のログイン画面をアプリ内のブラウザで開き、戻ってきたコードをセッションに換える
export async function signInWithGoogle(): Promise<void> {
  const supabase = requireSupabase();
  const redirectTo = Linking.createURL('auth-callback');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error('Google のログイン画面を開けませんでした');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') throw new Cancelled();

  const { queryParams } = Linking.parse(result.url);
  const authError = queryParams?.error_description ?? queryParams?.error;
  if (typeof authError === 'string') throw new Error(authError);
  const code = queryParams?.code;
  if (typeof code !== 'string') throw new Error('Google から戻ったリンクにコードがありません');
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;
}

export async function signOut(): Promise<void> {
  const supabase = requireSupabase();
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (userId) await unregisterPushToken(userId).catch(() => undefined);
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

const KNOWN_ERRORS: [RegExp, string][] = [
  [/invalid login credentials/i, 'メールアドレスかパスワードが違います。'],
  [/email not confirmed/i, 'メールアドレスの確認が済んでいません。'],
  [/user already registered/i, 'このメールアドレスはすでに登録されています。'],
  [/password should be at least/i, 'パスワードが短すぎます。'],
  [/unable to validate email address|invalid email/i, 'メールアドレスの形が正しくありません。'],
  [/network request failed|fetch failed/i, 'ネットワークにつながりません。'],
];

// 利用者に見せる文。キャンセルしたときは null（何も出さない）
export function errorMessage(error: unknown): string | null {
  if (error instanceof Cancelled) return null;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
  for (const [pattern, text] of KNOWN_ERRORS) {
    if (pattern.test(message)) return text;
  }
  return message;
}
