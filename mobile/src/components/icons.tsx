import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '../theme';

type IconProps = { size?: number; color?: string };

const stroke = {
  fill: 'none',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function ChevronLeft({ size = 24, color = colors.navy }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...stroke} stroke={color} strokeWidth={2.4}>
      <Path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

export function ChevronRight({ size = 16, color = colors.chevron }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...stroke} stroke={color} strokeWidth={2.6}>
      <Path d="M9 18l6-6-6-6" />
    </Svg>
  );
}

export function Check({ size = 22, color = colors.navy }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...stroke} stroke={color} strokeWidth={2.6}>
      <Path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function MoreCircle({ size = 24, color = colors.navy }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <Circle cx={12} cy={12} r={10} />
      <Circle cx={7.5} cy={12} r={1.3} fill={color} stroke="none" />
      <Circle cx={12} cy={12} r={1.3} fill={color} stroke="none" />
      <Circle cx={16.5} cy={12} r={1.3} fill={color} stroke="none" />
    </Svg>
  );
}

export function QrScan({ size = 22, color = colors.navy }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...stroke} stroke={color} strokeWidth={2}>
      <Path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <Path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <Path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <Path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <Rect x={7} y={7} width={10} height={10} rx={1} />
    </Svg>
  );
}

export function People({ size = 44, color = colors.navy }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" {...stroke} stroke={color} strokeWidth={1.8}>
      <Circle cx={9} cy={8} r={3.5} />
      <Path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <Circle cx={17} cy={9} r={2.5} />
      <Path d="M16 14.2a5 5 0 0 1 5.5 4.8" />
    </Svg>
  );
}
