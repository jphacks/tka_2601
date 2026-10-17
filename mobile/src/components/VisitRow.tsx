import { Pressable, StyleSheet, Text, View } from 'react-native';

import { callSeconds, durationLabel, hourMinute } from '../lib/format';
import { intentLabel, MODE_LABELS, outcomeLabel } from '../lib/labels';
import type { VisitSummary } from '../lib/types';
import { colors } from '../theme';
import { ChevronRight } from './icons';
import { IntentBadge } from './ui';

// 来客一覧の1行。意図、会社名、時刻、対応、訪問者の最初の発話、モードと通話時間
export function VisitRow({ visit, onPress }: { visit: VisitSummary; onPress: () => void }) {
  const seconds = callSeconds(visit.answered_at, visit.ended_at);
  const meta = [MODE_LABELS[visit.mode], seconds !== null ? `通話 ${durationLabel(seconds)}` : null]
    .filter(Boolean)
    .join('・');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <IntentBadge label={intentLabel(visit)} emphasis={visit.intent === 'emergency'} />
          {visit.company ? (
            <Text style={styles.company} numberOfLines={1}>
              {visit.company}
            </Text>
          ) : (
            <Text style={styles.noCompany} numberOfLines={1}>
              会社名なし
            </Text>
          )}
          <Text style={styles.time}>{hourMinute(new Date(visit.chimed_at))}</Text>
        </View>
        <Text style={styles.outcome}>{outcomeLabel(visit)}</Text>
        <Text style={styles.excerpt} numberOfLines={1}>
          {visit.first_visitor_text ? `「${visit.first_visitor_text}」` : '文字起こしなし'}
        </Text>
        <Text style={styles.meta}>{meta}</Text>
      </View>
      <ChevronRight />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 16,
    paddingRight: 12,
    backgroundColor: colors.card,
  },
  pressed: { backgroundColor: colors.separator },
  body: { flex: 1, minWidth: 0, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  company: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600', color: colors.text },
  noCompany: { flex: 1, minWidth: 0, fontSize: 17, color: colors.textSecondary },
  time: { fontSize: 15, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  outcome: { fontSize: 15, lineHeight: 22, color: colors.text },
  excerpt: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  meta: { fontSize: 13, lineHeight: 16, color: colors.textSecondary },
});
