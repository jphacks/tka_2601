import { useSyncExternalStore } from 'react';

// 開かれた招待リンクのトークン。ログイン前に開いたときは、ログイン後に参加の確認へ進むまで預かる
let token: string | null = null;
const listeners = new Set<() => void>();

export function setPendingInvite(next: string | null) {
  token = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingInvite(): string | null {
  return useSyncExternalStore(subscribe, () => token);
}
