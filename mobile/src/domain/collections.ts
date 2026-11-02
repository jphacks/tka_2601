// ページを足すとき、途中で行が増えて同じ id が重なっても1行だけにする
export function appendUnique<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  return [...current, ...next.filter((row) => !seen.has(row.id))];
}
