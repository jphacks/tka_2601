import type { ReactNode } from 'react';

// ネイティブはタブバーがあるので、そのまま出す
export function WebShell({ children }: { show: boolean; children: ReactNode }) {
  return children;
}
