// Web 版はポップアップを使わず、同じタブで同意画面へ移る。
// 同意を始めるまでに通信を待つので、ポップアップはブラウザに止められやすい。
// 同意のあとは戻り先の画面が開き直し、URL の問い合わせ（google=pending&code=...）で接続を完了する
export function openOAuthSession(url: string, _returnUrl: string): Promise<Record<string, unknown> | null> {
  window.location.assign(url);
  // ページを離れるので終わらない
  return new Promise(() => {});
}

export const OAUTH_RETURNS_TO_PAGE = true;
