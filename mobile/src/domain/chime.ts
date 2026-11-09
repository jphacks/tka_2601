// チャイム登録（本体にピンポン音を1回聞かせる）の状態と、画面に出す状態を決める規則。
// 契約は supabase/README.md の「チャイム登録」。アプリが依頼（request_seq）を出し、本体が handled_seq と phase で進捗を返す
export type ChimeAction = 'start' | 'cancel';
export type ChimePhase = 'idle' | 'noise' | 'listen' | 'analyze' | 'saving' | 'done' | 'failed' | 'cancelled';
export type ChimeReason =
  | 'too_noisy'
  | 'too_short'
  | 'clipped'
  | 'no_recording'
  | 'unstable'
  | 'background_matches'
  | 'busy';

export type ChimeEnrollmentState = {
  request_seq: number;
  action: ChimeAction | null;
  requested_at: string | null;
  handled_seq: number;
  phase: ChimePhase;
  reason: ChimeReason | null;
  // 本体が有効なチャイムのモデルを持つか。本体の報告だけが決める
  registered: boolean;
  reported_at: string | null;
};

// 本体の最後の通信がこの時間より新しければ、接続できているとみなす
export const HEARTBEAT_FRESH_MS = 3 * 60_000;
// 本体の接続を待つあいだ、本体の情報を読み直す間隔
export const DEVICE_POLL_MS = 3_000;
// 依頼を出したあと、進捗を読み直す間隔（チャイムの画面が見えているあいだだけ）
export const CHIME_POLL_MS = 1_500;
// 依頼を本体が拾わない、または読み取りが続けて失敗する長さ
export const PICKUP_TIMEOUT_MS = 20_000;
// 本体が音を待ち始めてから、鳴らされないまま待つ長さ
export const LISTEN_TIMEOUT_MS = 60_000;
// 静音の測定・解析・保存のあいだ、本体の報告が進まない長さ
export const STALL_TIMEOUT_MS = 30_000;

export function isHeartbeatFresh(lastHeartbeatAt: string | null, now: number): boolean {
  if (lastHeartbeatAt === null) return false;
  const time = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(time)) return false;
  // 時計が少し進んでいても、未来の時刻は新しいとみなす
  return now - time <= HEARTBEAT_FRESH_MS;
}

// 本体の失敗の理由のほかに、アプリが判断する失敗
export type ChimeFailure = ChimeReason | 'listen_timeout' | 'cancelled';

export type ChimeView =
  | { kind: 'waiting_device' }
  | { kind: 'requesting' }
  | { kind: 'quiet' }
  | { kind: 'listen' }
  | { kind: 'checking' }
  | { kind: 'done' }
  | { kind: 'failed'; reason: ChimeFailure }
  | { kind: 'timeout' };

export const CHIME_FAILURE_MESSAGES: Record<ChimeFailure, string> = {
  too_noisy: '周りがうるさい',
  too_short: '音が短い',
  clipped: '音が大きすぎる',
  unstable: '音が安定しない（少し離して鳴らしてください）',
  background_matches: '周りの音と似ている',
  busy: '本体が通話中で登録できない',
  no_recording: '録音できませんでした',
  listen_timeout: '音が聞こえませんでした',
  cancelled: '登録が中止されました',
};

export const CHIME_TIMEOUT_MESSAGE = '本体と通信できません';

// 失敗の画面に出す1行
export function chimeFailureMessage(view: ChimeView): string | null {
  if (view.kind === 'timeout') return CHIME_TIMEOUT_MESSAGE;
  if (view.kind === 'failed') return CHIME_FAILURE_MESSAGES[view.reason];
  return null;
}

// これ以上進まない状態。ここに着いたら読み直しをやめる
export function isTerminalChimeView(view: ChimeView): boolean {
  return view.kind === 'done' || view.kind === 'failed' || view.kind === 'timeout';
}

// 依頼を取り消す必要がある終わり方。本体が終えた done と failed は要らない。アプリが諦めた終わり方は、本体がまだ動いているかもしれない
export function needsCancel(view: ChimeView): boolean {
  return view.kind === 'timeout' || (view.kind === 'failed' && view.reason === 'listen_timeout');
}

// 本体の報告が最後に動いた時刻（アプリの時計）。phase が変わった時刻と、報告が届いた時刻のどちらかが進めば更新する
export type ChimeProgress = {
  handledSeq: number;
  phase: ChimePhase;
  reportedAt: string | null;
  changedAt: number;
  phaseSince: number;
};

export function trackProgress(
  previous: ChimeProgress | null,
  state: ChimeEnrollmentState | null,
  now: number,
): ChimeProgress | null {
  if (!state) return previous;
  const next = { handledSeq: state.handled_seq, phase: state.phase, reportedAt: state.reported_at };
  if (!previous) return { ...next, changedAt: now, phaseSince: now };
  const samePhase = previous.handledSeq === next.handledSeq && previous.phase === next.phase;
  const sameReport = samePhase && previous.reportedAt === next.reportedAt;
  return {
    ...next,
    changedAt: sameReport ? previous.changedAt : now,
    phaseSince: samePhase ? previous.phaseSince : now,
  };
}

export type ChimeRun = {
  // アプリが出した依頼の連番（request RPC の戻り値）
  requestSeq: number;
  // その依頼を出した時刻（アプリの時計）
  requestedAt: number;
  // 最後に進捗を読めた時刻（アプリの時計）。読めないまま続くと、本体と通信できないとみなす
  lastReadAt: number;
  state: ChimeEnrollmentState | null;
  progress: ChimeProgress | null;
};

// 依頼を出したあとの画面の状態。handled_seq が request_seq と等しいときだけ、phase は今の依頼の進捗になる
export function chimeRunView(run: ChimeRun, now: number): ChimeView {
  const { state } = run;
  // 別の人がもっと新しい依頼を出していたら、その依頼を追う（本体は1台で、登録は同時に1つしかできない）
  const seq = Math.max(run.requestSeq, state?.request_seq ?? 0);
  const handled = state?.handled_seq ?? 0;
  if (now - run.lastReadAt > PICKUP_TIMEOUT_MS) return { kind: 'timeout' };
  if (handled < seq) {
    return now - run.requestedAt > PICKUP_TIMEOUT_MS ? { kind: 'timeout' } : { kind: 'requesting' };
  }
  const phase = state?.phase ?? 'idle';
  if (phase === 'done') return { kind: 'done' };
  if (phase === 'failed') return { kind: 'failed', reason: state?.reason ?? 'no_recording' };
  if (phase === 'cancelled') return { kind: 'failed', reason: 'cancelled' };
  if (phase === 'listen') {
    const since = run.progress?.phaseSince ?? run.requestedAt;
    return now - since > LISTEN_TIMEOUT_MS ? { kind: 'failed', reason: 'listen_timeout' } : { kind: 'listen' };
  }
  const since = run.progress?.changedAt ?? run.requestedAt;
  if (now - since > STALL_TIMEOUT_MS) return { kind: 'timeout' };
  if (phase === 'noise') return { kind: 'quiet' };
  if (phase === 'idle') return { kind: 'requesting' };
  return { kind: 'checking' };
}

// 依頼を出す前の画面の状態。本体の通信が新しいときだけ依頼へ進む
export function chimeStartView(heartbeatFresh: boolean): ChimeView {
  return heartbeatFresh ? { kind: 'requesting' } : { kind: 'waiting_device' };
}

// 画面の段階（3つの点）。静かにする 1、鳴らす 2、確認 3。それ以外は点を出さない
export function chimeStep(view: ChimeView): 1 | 2 | 3 | null {
  if (view.kind === 'requesting' || view.kind === 'quiet') return 1;
  if (view.kind === 'listen') return 2;
  if (view.kind === 'checking') return 3;
  return null;
}

// 設定の行の右に出す、チャイムの登録の状態。読めなかったら状態不明
export function chimeRegistrationLabel(state: ChimeEnrollmentState | null | 'unknown'): string {
  if (state === 'unknown') return '状態不明';
  return state?.registered ? '登録済み' : '未登録';
}

export type OnboardingInput = {
  // 本体の有無を読み終えたか
  settled: boolean;
  // 本体の有無を読めなかった。読めなかったときは、本体なしとは別に扱い、案内へ移さない
  failed: boolean;
  hasDevice: boolean;
  // 「あとで」を押した
  skipped: boolean;
};

// 本体がなく、「あとで」も押していないお店だけが、初回の案内の対象になる。本体があれば、チャイムが未登録でも案内しない
export function needsOnboarding({ settled, failed, hasDevice, skipped }: OnboardingInput): boolean {
  return settled && !failed && !hasDevice && !skipped;
}

export function onboardingSkipKey(householdId: string): string {
  return `onboarding.skipped.${householdId}`;
}
