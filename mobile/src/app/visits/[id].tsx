import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MoreCircle } from '../../components/icons';
import { ConfirmDialog, MenuPopover } from '../../components/overlays';
import { NavBar, Screen } from '../../components/Screen';
import { CenterMessage, IntentBadge } from '../../components/ui';
import { deleteVisit, getVisit } from '../../lib/api';
import { errorMessage } from '../../lib/authActions';
import { callSeconds, durationLabel, hourMinute, hourMinuteSecond, monthDay } from '../../lib/format';
import { endReasonLabel, intentLabel, MODE_LABELS, outcomeLabel, SPEAKER_LABELS, visitTitle } from '../../lib/labels';
import type { Visit, VisitMessage } from '../../lib/types';
import { colors, radius } from '../../theme';

function callRange(visit: Visit): string {
  if (!visit.answered_at) return '—';
  const start = hourMinuteSecond(new Date(visit.answered_at));
  if (!visit.ended_at) return `${start}〜`;
  const seconds = callSeconds(visit.answered_at, visit.ended_at);
  const end = hourMinuteSecond(new Date(visit.ended_at));
  return seconds === null ? `${start}〜${end}` : `${start}〜${end}（${durationLabel(seconds)}）`;
}

export default function VisitDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<{ visit: Visit; messages: VisitMessage[] } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    getVisit(id)
      .then(setData)
      .catch((e) => setError(errorMessage(e) ?? '読み込めませんでした'));
  }, [id]);

  async function remove() {
    setConfirmOpen(false);
    try {
      await deleteVisit(id);
      router.back();
    } catch (e) {
      Alert.alert('削除できませんでした', errorMessage(e) ?? '');
    }
  }

  const visit = data?.visit;
  const back = () => router.back();

  return (
    <Screen>
      <NavBar
        title={visit ? visitTitle(visit) : undefined}
        backLabel="来客"
        onBack={back}
        right={
          visit ? (
            <Pressable
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="その他の操作"
              style={({ pressed }) => [styles.moreButton, pressed && styles.pressed]}
            >
              <MoreCircle />
            </Pressable>
          ) : null
        }
      />

      {error || data === null ? (
        <CenterMessage>{error ?? 'この来客の記録はありません'}</CenterMessage>
      ) : !visit || !data ? (
        <CenterMessage>
          <ActivityIndicator color={colors.navy} />
        </CenterMessage>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          <View style={styles.summary}>
            <View style={styles.summaryHead}>
              <IntentBadge label={intentLabel(visit)} emphasis={visit.intent === 'emergency'} />
              <Text style={styles.date}>
                {`${monthDay(new Date(visit.chimed_at))}${hourMinute(new Date(visit.chimed_at))}`}
              </Text>
            </View>
            <View style={styles.rule} />
            <View style={styles.facts}>
              <Fact label="対応" value={outcomeLabel(visit)} strong />
              <Fact label="終話の理由" value={endReasonLabel(visit.end_reason)} />
              <Fact label="モード" value={MODE_LABELS[visit.mode]} />
              <Fact label="通話" value={callRange(visit)} />
            </View>
          </View>

          <Text style={styles.sectionTitle} accessibilityRole="header">
            会話
          </Text>
          <View style={styles.chat}>
            {data.messages.map((message) => (
              <Bubble key={message.seq} message={message} />
            ))}
          </View>
        </ScrollView>
      )}

      <MenuPopover
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          {
            label: 'この記録を削除',
            onPress: () => {
              setMenuOpen(false);
              setConfirmOpen(true);
            },
          },
        ]}
      />
      <ConfirmDialog
        visible={confirmOpen}
        title="この記録を削除しますか"
        confirmLabel="削除"
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, strong && styles.factStrong]}>{value}</Text>
    </View>
  );
}

// 訪問者は左に白、AI は右に紺、定型音声は右に薄い紺
function Bubble({ message }: { message: VisitMessage }) {
  const fromVisitor = message.speaker === 'visitor';
  const bubbleStyle =
    message.speaker === 'visitor' ? styles.visitor : message.speaker === 'ai' ? styles.ai : styles.canned;
  const textStyle =
    message.speaker === 'visitor' ? styles.visitorText : message.speaker === 'ai' ? styles.aiText : styles.cannedText;
  return (
    <View style={[styles.bubbleRow, { alignItems: fromVisitor ? 'flex-start' : 'flex-end' }]}>
      <Text style={styles.speaker}>{SPEAKER_LABELS[message.speaker]}</Text>
      <View style={[styles.bubble, bubbleStyle]}>
        <Text style={[styles.bubbleText, textStyle]}>{message.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  moreButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.5 },
  summary: {
    marginTop: 8,
    marginHorizontal: 16,
    padding: 16,
    backgroundColor: colors.card,
    borderRadius: radius.section,
    gap: 14,
  },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  date: { fontSize: 15, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  rule: { height: 1, backgroundColor: colors.separator },
  facts: { gap: 10 },
  fact: { flexDirection: 'row', gap: 12 },
  factLabel: { width: 88, fontSize: 15, lineHeight: 22, color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.text, fontVariant: ['tabular-nums'] },
  factStrong: { fontWeight: '600' },
  sectionTitle: {
    paddingTop: 24,
    paddingHorizontal: 20,
    paddingBottom: 10,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  chat: { paddingHorizontal: 16, gap: 14 },
  bubbleRow: { gap: 4 },
  speaker: { paddingHorizontal: 6, fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  bubble: { maxWidth: 280, paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.bubble },
  bubbleText: { fontSize: 16, lineHeight: 25 },
  visitor: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.separator,
    borderBottomLeftRadius: radius.bubbleTail,
  },
  visitorText: { color: colors.text },
  ai: { backgroundColor: colors.navy, borderBottomRightRadius: radius.bubbleTail },
  aiText: { color: '#FFFFFF' },
  canned: { backgroundColor: colors.navyTint, borderBottomRightRadius: radius.bubbleTail },
  cannedText: { color: colors.navy },
});
