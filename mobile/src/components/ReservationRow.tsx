import { Pressable, StyleSheet, Text, View } from 'react-native';

import { customerLabel, type Reservation } from '../domain/reservation';
import { hourMinute } from '../lib/format';
import { reservationBadge } from '../lib/labels';
import { colors } from '../theme';
import { ChevronRight } from './icons';
import { IntentBadge } from './ui';

// 予約の1行。左に開始と終了、右にお客様、状態の札、メニュー
export function ReservationRow({ reservation, onPress }: { reservation: Reservation; onPress: () => void }) {
  const badge = reservationBadge(reservation);
  const start = hourMinute(new Date(reservation.starts_at));
  const end = hourMinute(new Date(reservation.ends_at));
  const name = customerLabel(reservation);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[`${start}から${end}`, name, reservation.service_name, badge].filter(Boolean).join('、')}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.times}>
        <Text style={styles.start} numberOfLines={1}>{start}</Text>
        <Text style={styles.end} numberOfLines={1}>{end}</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {badge ? <IntentBadge label={badge} emphasis={!!reservation.arrived_at} /> : null}
        </View>
        {reservation.service_name ? (
          <Text style={styles.service} numberOfLines={1}>
            {reservation.service_name}
          </Text>
        ) : null}
      </View>
      <ChevronRight />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 12,
    backgroundColor: colors.card,
  },
  pressed: { backgroundColor: colors.separator },
  times: { width: 56, gap: 1 },
  start: { fontSize: 17, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  end: { fontSize: 13, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: '600', color: colors.text },
  service: { fontSize: 15, lineHeight: 22, color: colors.textTertiary },
});
