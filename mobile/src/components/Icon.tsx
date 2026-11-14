import { SymbolView, type SymbolWeight } from 'expo-symbols';

import type { SymbolName } from '../lib/symbols';
import { colors } from '../theme';

// OS のシンボルを出す
export function Icon({
  name,
  size = 24,
  color = colors.navy,
  weight,
}: {
  name: SymbolName;
  size?: number;
  color?: string;
  weight?: SymbolWeight;
}) {
  return <SymbolView name={name} size={size} tintColor={color} weight={weight} />;
}
