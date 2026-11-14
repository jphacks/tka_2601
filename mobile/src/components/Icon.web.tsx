import { Text } from 'react-native';

import type { SymbolName } from '../lib/symbols';
import { colors } from '../theme';

// Web には OS のシンボルがないので、Android と同じ Material Symbols の名前を字形で出す（フォントは webPolyfills が読み込む）
export function Icon({ name, size = 24, color = colors.navy }: { name: SymbolName; size?: number; color?: string }) {
  return (
    <Text
      selectable={false}
      accessible={false}
      style={{
        fontFamily: 'Material Symbols Outlined',
        fontSize: size,
        lineHeight: size,
        width: size,
        height: size,
        color,
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      {name.android}
    </Text>
  );
}
