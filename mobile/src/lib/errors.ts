export class Cancelled extends Error {}

export function hasErrorCode(error: unknown, code: string): boolean {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return false;
  return 'code' in error && error.code === code;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

const KNOWN_ERRORS: readonly (readonly [RegExp, string])[] = [
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
  const message = getErrorMessage(error);
  for (const [pattern, text] of KNOWN_ERRORS) {
    if (pattern.test(message)) return text;
  }
  return message;
}
