import { useCallback, useEffect, useRef, useState } from 'react';

import type { Device } from '../domain/device';
import { normalizePairingCode, pairingFailureMessage, pairingResultUnknown } from '../domain/devicePairing';
import { repositories } from './container';

export type DeviceClaim = {
  // お店の本体。まだなければ null
  device: Device | null;
  code: string;
  setCode: (code: string) => void;
  loading: boolean;
  saving: boolean;
  error: string | null;
  // コードが見つからない（または使用済み）で失敗した
  codeRejected: boolean;
  // 登録の依頼は受け付けられたが、本体を読めていない
  claimedId: string | null;
  // 登録の結果が分からない。コードを送り直さず、本体の確認だけをする
  claimPending: boolean;
  canClaim: boolean;
  claim: () => Promise<void>;
  reload: (expectedId?: string) => Promise<void>;
};

// 本体の登録（ペアリングコード）。設定の画面と初回の案内の画面が共有する。
// 本体の登録の依頼が消費済みのコードを再送しないよう、結果が不明なときは本体の確認だけを再試行する。
// 登録した本体を読めたら onClaimed を呼ぶ
export function useDeviceClaim(householdId: string, onClaimed?: (device: Device) => void): DeviceClaim {
  const [device, setDevice] = useState<Device | null>(null);
  const [code, setCodeState] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeRejected, setCodeRejected] = useState(false);
  // RPC後に読込が失敗しても、消費済みコードを再送せず結果の取得だけを再試行する。
  const [claimedId, setClaimedId] = useState<string | null>(null);
  const [claimPending, setClaimPending] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);
  const claimed = useRef(onClaimed);

  useEffect(() => {
    claimed.current = onClaimed;
  });

  const load = useCallback(async (expectedId?: string) => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    setCodeRejected(false);
    try {
      const current = await repositories.devices.get(householdId);
      if (request !== generation.current) return;
      if (expectedId && current?.id !== expectedId) {
        setError('登録結果を読み込めませんでした。本体をもう一度確認してください。');
      } else {
        setDevice(current);
        setClaimPending(false);
        if (expectedId && current) claimed.current?.(current);
      }
    } catch {
      if (request === generation.current) setError('本体情報を読み込めませんでした。接続を確認して再試行してください。');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [householdId]);

  useEffect(() => {
    mounted.current = true;
    const request = ++generation.current;
    repositories.devices.get(householdId)
      .then((current) => { if (request === generation.current) setDevice(current); })
      .catch(() => {
        if (request === generation.current) setError('本体情報を読み込めませんでした。接続を確認して再試行してください。');
      })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { mounted.current = false; generation.current += 1; };
  }, [householdId]);

  // 見つからなかったコードを直し始めたら、その誤りは消す
  const setCode = useCallback((next: string) => {
    setCodeState(next);
    if (codeRejected) {
      setCodeRejected(false);
      setError(null);
    }
  }, [codeRejected]);

  const canClaim = !device && !claimedId && !claimPending && !loading && !saving && !!normalizePairingCode(code);

  const claim = useCallback(async () => {
    if (busy.current || device || claimedId || claimPending || loading || !normalizePairingCode(code)) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    setCodeRejected(false);
    const request = generation.current;
    try {
      const id = await repositories.devices.claim(code);
      if (request !== generation.current) return;
      setClaimedId(id);
      setCodeState('');
      await load(id);
    } catch (reason) {
      if (request === generation.current) {
        setError(pairingFailureMessage(reason));
        setCodeRejected(!!reason && typeof reason === 'object' && 'code' in reason && reason.code === 'PT404');
        setClaimPending(pairingResultUnknown(reason));
      }
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [claimPending, claimedId, code, device, load, loading]);

  return { device, code, setCode, loading, saving, error, codeRejected, claimedId, claimPending, canClaim, claim, reload: load };
}
