// 同意が済んだトークンを、始めた本人が確かめるまで保留にする（docs/reservations.md 3.1）。
// コールバックには JWT がないので、誰が同意したかは分からない。同意の URL を他人に開かせると、
// 他人の予約を自分のグループへ結び付けられてしまう。そこでコールバックではトークンを保留にし、
// アプリが JWT 付きで完了を呼び、始めた本人だと確かめてから接続にする
import type { CalendarStore, OAuthProvider } from "../_shared/calendar_store.ts";
import { ProviderError } from "../_shared/reservation.ts";
import { decryptToken, encryptToken } from "../_shared/token_crypto.ts";

export const PENDING_TTL_MS = 10 * 60 * 1000;

export type PendingOwner = { household_id: string; user_id: string };
export type CompletingMember = { userId: string; householdId: string };

export async function holdTokens(
  store: Pick<CalendarStore, "savePending">,
  tokenKey: string,
  provider: OAuthProvider,
  owner: PendingOwner,
  payload: unknown,
): Promise<string> {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  await store.savePending({
    code,
    provider,
    household_id: owner.household_id,
    user_id: owner.user_id,
    payload_encrypted: await encryptToken(JSON.stringify(payload), tokenKey),
  });
  return code;
}

const invalidCode = () => new ProviderError(404, "接続の手続きが無効です。アプリからやり直してください", "oauth_code_invalid");

// 保留は使い切りで、本人でないと分かった時点でも消える
export async function takeTokens<T>(
  store: Pick<CalendarStore, "takePending">,
  tokenKey: string,
  provider: OAuthProvider,
  code: unknown,
  member: CompletingMember,
  now: Date,
): Promise<T> {
  if (typeof code !== "string" || code === "") throw invalidCode();
  const pending = await store.takePending(code);
  if (!pending || pending.provider !== provider) throw invalidCode();
  if (now.getTime() - Date.parse(pending.created_at) > PENDING_TTL_MS) throw invalidCode();
  if (pending.user_id !== member.userId || pending.household_id !== member.householdId) {
    throw new ProviderError(403, "接続を始めた人と違います。アプリからやり直してください", "oauth_user_mismatch");
  }
  try {
    return JSON.parse(await decryptToken(pending.payload_encrypted, tokenKey)) as T;
  } catch {
    throw invalidCode();
  }
}
