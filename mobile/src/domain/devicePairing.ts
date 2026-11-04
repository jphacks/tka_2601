// 発行されるコードは8文字。空白とハイフンは区切りとして受け付ける。
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[2-9A-HJ-NP-Z]{8}$/.test(code) ? code : null;
}

export function pairingFailureMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'PT404') return 'コードが見つからないか、すでに使用されています。コードを確認してください。';
  if (code === 'PT403' || code === '42501') return 'ログインとお店への参加を確認してください。';
  if (code === 'PT409') return 'このお店には本体が登録されています。設定から確認してください。';
  if (code === '23505') return 'この本体はすでに別のお店に登録されています。';
  return '登録結果を確認できませんでした。設定で本体を確認してから、もう一度お試しください。';
}

export function pairingResultUnknown(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return !['PT404', 'PT403', 'PT409', '42501', '23505'].includes(String(code));
}
