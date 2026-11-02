export class Cancelled extends Error {}

// Edge Function が返した本文の error をそのまま持つ。status で 403 や 409 を見分ける
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  assistant_unavailable: '今は入力を読み取れません。',
  oauth_code_invalid: 'ログインの手続きが無効です。もう一度ログインしてください。',
  oauth_user_mismatch: 'ログインを始めた人のアカウントで操作してください。',
  provider_read_only: 'Square の予約は Square で変更してください。',
  square_not_configured: 'Square の接続が設定されていません',
  square_not_connected: 'Square の接続が済んでいません。',
  square_reauth_required: 'Square にログインし直してください。',
  square_unavailable: 'Square に接続できません。',
};

const KNOWN_ERRORS: readonly (readonly [RegExp, string])[] = [
  [/invalid login credentials/i, 'メールアドレスかパスワードが違います。'],
  [/email not confirmed/i, 'メールアドレスの確認が済んでいません。'],
  [/user already registered/i, 'このメールアドレスはすでに登録されています。'],
  [/password should be at least/i, 'パスワードが短すぎます。'],
  [/unable to validate email address|invalid email/i, 'メールアドレスの形が正しくありません。'],
  [/network request failed|fetch failed|failed to send a request/i, 'ネットワークにつながりません。'],
];

// 利用者に見せる文。キャンセルしたときは null（何も出さない）
export function errorMessage(error: unknown): string | null {
  if (error instanceof Cancelled) return null;
  if (error instanceof ApiError && error.code && CODE_MESSAGES[error.code]) return CODE_MESSAGES[error.code];
  const message = getErrorMessage(error);
  for (const [pattern, text] of KNOWN_ERRORS) {
    if (pattern.test(message)) return text;
  }
  return message;
}
