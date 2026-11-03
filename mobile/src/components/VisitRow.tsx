import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { VisitSummary } from '../domain/visit';
import { hourMinute } from '../lib/format';
import { intentLabel, outcomeLabel, visitTitle } from '../lib/labels';
import { intentSymbol } from '../lib/symbols';
import { colors } from '../theme';
import { ChevronRight } from './icons';
import { RoundIcon } from './ui';

// 来客一覧の1行。左に意図の丸、会社名か意図、時刻、対応、訪問者の最初の発話
export function VisitRow({ visit, onPress }: { visit: VisitSummary; onPress: () => void }) {
  const time = hourMinute(new Date(visit.chimed_at));
  const outcome = outcomeLabel(visit);
  const excerpt = visit.first_visitor_text ? `「${visit.first_visitor_text}」` : '文字起こしなし';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[intentLabel(visit), visit.company, time, outcome, excerpt].filter(Boolean).join('、')}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <RoundIcon name={intentSymbol(visit.intent)} filled={visit.intent === 'emergency'} />
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text style={styles.title} numberOfLines={1}>
            {visitTitle(visit)}
          </Text>
          <Text style={styles.time}>{time}</Text>
        </View>
        <Text style={styles.outcome}>{outcome}</Text>
        <Text style={styles.excerpt} numberOfLines={1}>
          {excerpt}
        </Text>
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
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 12,
    backgroundColor: colors.card,
  },
  pressed: { backgroundColor: colors.separator },
  body: { flex: 1, minWidth: 0, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600', color: colors.text },
  time: { fontSize: 15, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  outcome: { fontSize: 15, lineHeight: 22, color: colors.text },
  excerpt: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
});
