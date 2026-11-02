// 続きを読む位置。行を足しても重ならないよう、時刻と id で決める
export type PageCursor = { at: string; id: string };

// 新しい順の一覧で、位置より後ろの行を選ぶ PostgREST の条件
export function keysetFilter(column: string, cursor: PageCursor): string {
  return `${column}.lt."${cursor.at}",and(${column}.eq."${cursor.at}",id.lt.${cursor.id})`;
}

// ページを足すとき、途中で行が増えて同じ id が重なっても1行だけにする
export function appendUnique<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  return [...current, ...next.filter((row) => !seen.has(row.id))];
}
