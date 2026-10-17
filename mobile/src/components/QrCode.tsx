import QRCode from 'react-native-qrcode-svg';

import { colors } from '../theme';

export function QrCode({ value, size }: { value: string; size: number }) {
  return <QRCode value={value} size={size} color={colors.text} backgroundColor={colors.card} ecl="M" />;
}
