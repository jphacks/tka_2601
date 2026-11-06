import type { Mode } from './visit';

export type Device = {
  id: string;
  household_id: string;
  name: string | null;
  // アプリが保存したモード（クラウドの設定）。本体が実際に動かしているモードとは限らない
  mode: Mode;
  // 本体が最後に報告した、実際に動かしているモード。一度も報告がなければ null。保存した mode と食い違うことがある
  applied_mode: Mode | null;
  // その報告をクラウドが受けた時刻（ISO 8601）。applied_mode が null のときも null。本体の生存は示さない
  applied_mode_at: string | null;
  // 本体からの最後の死活通信（heartbeat）の時刻（ISO 8601）。一度も届いていなければ null
  last_heartbeat_at: string | null;
  away_leave_at_door: boolean;
  auto_away: boolean;
  extra_instructions: string;
};

export type DevicePatch = Partial<Pick<Device, 'mode' | 'away_leave_at_door' | 'auto_away' | 'extra_instructions'>>;
