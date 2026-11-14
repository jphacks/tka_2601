import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { NavBar, Screen } from '../../components/Screen';
import { DefinitionList, PrimaryButton, SoftButton } from '../../components/ui';
import type { AssistantProposal, DayHours, SetBusinessHoursProposal } from '../../domain/assistant';
import { newIdempotencyKey } from '../../domain/reservation';
import { applyDayHours } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { useBadges } from '../../lib/badges';
import { repositories } from '../../lib/container';
import { errorMessage, hasErrorCode } from '../../lib/errors';
import { dateTimeRange, weekdayName } from '../../lib/format';
import { colors, radius } from '../../theme';

// サーバーが受け付ける長さ
const MAX_TEXT_LENGTH = 200;

type Phase = 'idle' | 'sending' | 'ready' | 'saving' | 'done' | 'failed';

function hoursLabel(hours: DayHours): string {
  if (hours.closed) return '定休日';
  return hours.open && hours.close ? `${hours.open}〜${hours.close}` : '未設定';
}

function cardTitle(proposal: AssistantProposal): string {
  if (proposal.type === 'add_reservation') return '予約を追加';
  if (proposal.type === 'update_reservation') return '予約を変更';
  if (proposal.type === 'set_business_hours') return '営業時間を変更';
  return '読み取れませんでした';
}

function cardRows(proposal: AssistantProposal): { label: string; value: string; strong?: boolean }[] {
  if (proposal.type === 'add_reservation') {
    return [
      { label: 'お客様', value: `${proposal.customer_name}様`, strong: true },
      { label: '日時', value: dateTimeRange(proposal.starts_at, proposal.ends_at), strong: true },
      ...(proposal.service_name ? [{ label: 'メニュー', value: proposal.service_name }] : []),
      { label: '電話', value: proposal.customer_phone ?? '未入力' },
      ...(proposal.note ? [{ label: 'メモ', value: proposal.note }] : []),
    ];
  }
  if (proposal.type === 'update_reservation') {
    const customer = [`${proposal.customer_name}様`, proposal.service_name].filter(Boolean).join('　');
    return [
      { label: 'お客様', value: customer, strong: true },
      { label: '変更前', value: dateTimeRange(proposal.before.starts_at, proposal.before.ends_at) },
      { label: '変更後', value: dateTimeRange(proposal.after.starts_at, proposal.after.ends_at), strong: true },
    ];
  }
  if (proposal.type === 'set_business_hours') {
    return [
      { label: '曜日', value: weekdayName(proposal.day), strong: true },
      { label: '変更前', value: hoursLabel(proposal.before) },
      { label: '変更後', value: hoursLabel(proposal.after), strong: true },
    ];
  }
  return [];
}

// 読み取った案を入力フォームへ渡して直す
function openForm(proposal: AssistantProposal | null) {
  if (proposal?.type === 'add_reservation') {
    const minutes = (new Date(proposal.ends_at).getTime() - new Date(proposal.starts_at).getTime()) / 60_000;
    router.push({
      pathname: '/reservations/edit',
      params: {
        name: proposal.customer_name,
        phone: proposal.customer_phone ?? undefined,
        service: proposal.service_name ?? undefined,
        note: proposal.note ?? undefined,
        date: proposal.starts_at,
        duration: String(Math.round(minutes)),
      },
    });
  } else if (proposal?.type === 'update_reservation') {
    const minutes = (new Date(proposal.after.ends_at).getTime() - new Date(proposal.after.starts_at).getTime()) / 60_000;
    router.push({
      pathname: '/reservations/edit',
      params: { id: proposal.reservation_id, date: proposal.after.starts_at, duration: String(Math.round(minutes)) },
    });
  } else if (proposal?.type === 'set_business_hours') {
    router.push('/settings/shop');
  } else {
    router.push('/reservations/edit');
  }
}

export default function AssistantScreen() {
  const household = useHousehold();
  const { refresh: refreshBadges } = useBadges();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [request, setRequest] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AssistantProposal | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  // 案ごとに1つ。追加を送り直しても二重に作らない
  const idempotencyKey = useRef(newIdempotencyKey());

  async function send() {
    const message = text.trim();
    if (!message || phase === 'sending' || phase === 'saving') return;
    setRequest(message);
    setText('');
    setProposal(null);
    setFailure(null);
    setPhase('sending');
    idempotencyKey.current = newIdempotencyKey();
    try {
      const next = await repositories.assistant.parse(message);
      setProposal(next);
      setPhase(next.type === 'unknown' ? 'failed' : 'ready');
    } catch (e) {
      setFailure(errorMessage(e) ?? '読み取れませんでした');
      setPhase('failed');
    }
  }

  async function saveBusinessHours(next: SetBusinessHoursProposal) {
    const profile = await repositories.shop.getProfile(household.id);
    if (!profile) throw new Error('店舗の設定を読み込めませんでした');
    await repositories.shop.updateProfile(household.id, {
      business_hours: applyDayHours(profile.business_hours, next.day, next.after),
    });
  }

  function closeCard() {
    setRequest(null);
    setProposal(null);
    setFailure(null);
    setPhase('idle');
  }

  // フォームで直すならカードを閉じる。残すと、戻ってから同じ案をもう一度書き込める
  function correct(target: AssistantProposal) {
    closeCard();
    openForm(target);
  }

  // 確認カードで承認されてから書き込む
  async function confirm() {
    if (!proposal) return;
    setPhase('saving');
    setFailure(null);
    try {
      if (proposal.type === 'add_reservation') {
        await repositories.reservations.create({
          customer_name: proposal.customer_name,
          customer_phone: proposal.customer_phone,
          service_name: proposal.service_name,
          starts_at: proposal.starts_at,
          ends_at: proposal.ends_at,
          note: proposal.note,
        }, idempotencyKey.current);
      } else if (proposal.type === 'update_reservation') {
        await repositories.reservations.update(proposal.reservation_id, proposal.after, proposal.before);
      } else if (proposal.type === 'set_business_hours') {
        await saveBusinessHours(proposal);
      }
      refreshBadges();
      setPhase('done');
    } catch (e) {
      // カードの内容が古いので、そのまま送り直させない
      if (hasErrorCode(e, 'reservation_changed')) {
        closeCard();
        Alert.alert('予約が変更されています', 'もう一度入力してください。');
        return;
      }
      setFailure(errorMessage(e) ?? '保存できませんでした');
      setPhase('ready');
    }
  }

  const reason = failure ?? (proposal?.type === 'unknown' ? proposal.reason : '');
  const canSend = !!text.trim() && phase !== 'sending' && phase !== 'saving';
  const warnings = proposal?.warnings ?? [];

  return (
    <Screen waves={false}>
      <NavBar title="入力" backLabel="予約" onBack={() => router.back()} />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {request ? <Text style={styles.bubble}>{request}</Text> : null}

          {phase === 'sending' ? (
            <View style={styles.sending} accessibilityLabel="読み取り中">
              <ActivityIndicator color={colors.navy} />
            </View>
          ) : null}

          {proposal && proposal.type !== 'unknown' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle} accessibilityRole="header">
                {cardTitle(proposal)}
              </Text>
              <View style={styles.divider} />
              <DefinitionList rows={cardRows(proposal)} />
              {warnings.map((warning) => (
                <Text key={warning} style={styles.warning} accessibilityRole="alert">
                  {warning}
                </Text>
              ))}
              {failure ? (
                <Text style={styles.warning} accessibilityRole="alert">
                  {failure}
                </Text>
              ) : null}
              {phase === 'done' ? (
                <Text style={styles.done} accessibilityRole="text">
                  {proposal.type === 'add_reservation' ? '追加しました' : '変更しました'}
                </Text>
              ) : (
                <View style={styles.actions}>
                  <SoftButton
                    label="修正"
                    disabled={phase === 'saving'}
                    onPress={() => correct(proposal)}
                    style={styles.action}
                  />
                  <PrimaryButton
                    label={proposal.type === 'add_reservation' ? '追加' : '変更'}
                    loading={phase === 'saving'}
                    onPress={confirm}
                    style={styles.action}
                  />
                </View>
              )}
            </View>
          ) : null}

          {phase === 'failed' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle} accessibilityRole="header">
                読み取れませんでした
              </Text>
              {reason ? <Text style={styles.reason}>{reason}</Text> : null}
              <PrimaryButton label="フォームで入力" onPress={() => openForm(null)} />
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="予約や設定を入力"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="予約や設定を入力"
            autoFocus
            maxLength={MAX_TEXT_LENGTH}
            returnKeyType="send"
            onSubmitEditing={send}
            style={styles.input}
          />
          <Pressable
            onPress={send}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="送信"
            style={({ pressed }) => [styles.send, (pressed || !canSend) && styles.sendDim]}
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M12 19V5M6 11l6-6 6 6" />
            </Svg>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingVertical: 12, paddingHorizontal: 16, gap: 14 },
  bubble: {
    alignSelf: 'flex-end',
    maxWidth: 280,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    borderBottomLeftRadius: radius.bubble,
    borderBottomRightRadius: radius.bubbleTail,
    overflow: 'hidden',
    backgroundColor: colors.navy,
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 25,
  },
  sending: { minHeight: 80, alignItems: 'center', justifyContent: 'center' },
  card: { padding: 16, gap: 14, borderRadius: radius.section, backgroundColor: colors.card },
  cardTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
  divider: { height: 1, backgroundColor: colors.separator },
  warning: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.navyTint,
    color: colors.navy,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
  },
  reason: { fontSize: 15, lineHeight: 22, color: colors.textTertiary },
  done: { minHeight: 50, textAlign: 'center', textAlignVertical: 'center', lineHeight: 50, fontSize: 17, fontWeight: '600', color: colors.navy },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    backgroundColor: colors.background,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 44,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 22,
    backgroundColor: colors.card,
    fontSize: 16,
    color: colors.text,
  },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  sendDim: { opacity: 0.5 },
});
