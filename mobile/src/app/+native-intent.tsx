import { inviteTokenFromUrl } from '../lib/app';
import { setPendingInvite } from '../lib/pendingInvite';

// 招待リンク（tka2601://join?token=...）を開いたら、トークンを預かってから画面を開く。
// ログイン前なら /join は開けずログイン画面になるので、ログイン後に預かったトークンで参加の確認へ進む
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    const token = inviteTokenFromUrl(path);
    if (token) setPendingInvite(token);
  } catch {
    // 読めない URL はそのまま通す
  }
  return path;
}
