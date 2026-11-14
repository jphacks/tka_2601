import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHIME_POLL_MS,
  chimeRunView,
  chimeStartView,
  type ChimeEnrollmentState,
  type ChimeProgress,
  type ChimeView,
  DEVICE_POLL_MS,
  isHeartbeatFresh,
  isTerminalChimeView,
  needsCancel,
  trackProgress,
} from '../domain/chime';
import { repositories } from './container';

// チャイム登録の画面の進み。本体の接続を待ち、依頼を出し、本体の進捗を読み直す。
// 判断はすべて domain/chime.ts にあり、ここは読み直しの間隔と取り消しだけを持つ。
// 画面が見えているあいだだけ読み、見えなくなったときに終わっていなければ取り消す（取り消しは最善の努力）
export function useChimeEnrollment(householdId: string, onDone: () => void) {
  const [view, setView] = useState<ChimeView>({ kind: 'waiting_device' });
  const [attempt, setAttempt] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deviceId: string | null = null;
      // 依頼を出した後だけ持つ
      let run: {
        requestSeq: number;
        requestedAt: number;
        lastReadAt: number;
        state: ChimeEnrollmentState | null;
        progress: ChimeProgress | null;
      } | null = null;
      let finished = false;

      const cancel = () => {
        if (deviceId) void repositories.chimeEnrollment.request(deviceId, 'cancel').catch(() => undefined);
      };

      const finish = (next: ChimeView) => {
        finished = true;
        setView(next);
        if (next.kind === 'done') done.current();
        else if (needsCancel(next)) cancel();
      };

      const schedule = (ms: number) => {
        if (active && !finished) timer = setTimeout(() => void tick(), ms);
      };

      async function tick() {
        if (!active || finished) return;
        try {
          if (!run) {
            const device = await repositories.devices.get(householdId);
            if (!active) return;
            const start = chimeStartView(!!device && isHeartbeatFresh(device.last_heartbeat_at, Date.now()));
            if (!device || start.kind === 'waiting_device') {
              setView({ kind: 'waiting_device' });
              schedule(DEVICE_POLL_MS);
              return;
            }
            deviceId = device.id;
            setView(start);
            const requestSeq = await repositories.chimeEnrollment.request(device.id, 'start');
            if (!active) {
              // 依頼を出した直後に画面を離れた
              cancel();
              return;
            }
            const now = Date.now();
            run = { requestSeq, requestedAt: now, lastReadAt: now, state: null, progress: null };
            schedule(CHIME_POLL_MS);
            return;
          }
          if (!deviceId) return;
          let state: ChimeEnrollmentState | null = null;
          let read = false;
          try {
            state = await repositories.chimeEnrollment.get(deviceId);
            read = true;
          } catch {
            // 読めなかった回。続けて読めない長さは domain が数える
          }
          if (!active) return;
          const now = Date.now();
          if (read) {
            run.lastReadAt = now;
            run.state = state;
            run.progress = trackProgress(run.progress, state, now);
          }
          const next = chimeRunView(run, now);
          if (isTerminalChimeView(next)) {
            finish(next);
            return;
          }
          setView(next);
          schedule(CHIME_POLL_MS);
        } catch {
          if (!active) return;
          // 依頼を出せなかった、または本体の情報を読めなかった。このまま待っても進まない
          if (run) {
            schedule(CHIME_POLL_MS);
            return;
          }
          if (deviceId) finish({ kind: 'timeout' });
          else schedule(DEVICE_POLL_MS);
        }
      }

      void tick();

      return () => {
        active = false;
        clearTimeout(timer);
        // 依頼を出していて、まだ終わっていないときだけ取り消す
        if (run && !finished) cancel();
      };
      // attempt は「もう一度登録する」で、新しい依頼を出し直すための合図
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [householdId, attempt]),
  );

  // もう一度登録する。新しい依頼を出す
  const restart = useCallback(() => {
    setView({ kind: 'requesting' });
    setAttempt((current) => current + 1);
  }, []);

  return { view, restart };
}
