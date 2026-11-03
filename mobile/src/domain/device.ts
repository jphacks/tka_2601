import type { Mode } from './visit';

export type Device = {
  id: string;
  household_id: string;
  name: string | null;
  mode: Mode;
  away_leave_at_door: boolean;
  auto_away: boolean;
  extra_instructions: string;
};

export type DevicePatch = Partial<Pick<Device, 'mode' | 'away_leave_at_door' | 'auto_away' | 'extra_instructions'>>;
