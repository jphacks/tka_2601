import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, GroupHeader, LinkRow, NavTextButton, RadioRow, Separator } from '../../components/ui';
import type { Tone, WalkInPolicy } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { repositories } from '../../lib/container';
import { SYMBOLS } from '../../lib/symbols';
import { errorMessage } from '../../lib/errors';
import { TONE_LABELS, TONE_ORDER, WALK_IN_LABELS, WALK_IN_ORDER } from '../../lib/labels';
import { colors, radius } from '../../theme';

// DB の check 制約と同じ値
const GREETING_MAX_LENGTH = 80;

export default function ResponsesScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [tone, setTone] = useState<Tone>('very_polite');
  const [greeting, setGreeting] = useState('');
  const [walkIn, setWalkIn] = useState<WalkInPolicy>('take_reservation');
  const [hasInstructions, setHasInstructions] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    repositories.shop
      .getProfile(household.id)
      .then((profile) => {
        if (!profile) {
          Alert.alert('読み込めませんでした');
          return;
        }
        setTone(profile.tone);
        setGreeting(profile.greeting);
        setWalkIn(profile.walk_in_policy);
        setLoaded(true);
      })
      .catch((e) => Alert.alert('読み込めませんでした', errorMessage(e) ?? ''));
  }, [household.id]);

  // 追加の指示の画面から戻ったときに、設定済みかを読み直す
  useFocusEffect(
    useCallback(() => {
      repositories.devices
        .get(household.id)
        .then((device) => setHasInstructions(!!device?.extra_instructions))
        .catch(() => setHasInstructions(null));
    }, [household.id]),
  );

  async function save() {
    setSaving(true);
    try {
      await repositories.shop.updateProfile(household.id, { tone, greeting: greeting.trim(), walk_in_policy: walkIn });
      router.back();
    } catch (e) {
      Alert.alert('保存できませんでした', errorMessage(e) ?? '');
    } finally {
      setSaving(false);
    }
  }

  const canSave = loaded && !saving;

  return (
    <Screen waves={false}>
      <NavBar
        title="受け答え"
        backLabel="設定"
        onBack={() => router.back()}
        right={<NavTextButton label="保存" disabled={!canSave} loading={saving} onPress={save} />}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <GroupHeader title="口調" first />
          <Card>
            {TONE_ORDER.map((value, index) => (
              <Fragment key={value}>
                {index > 0 ? <Separator /> : null}
                <RadioRow label={TONE_LABELS[value]} selected={tone === value} onPress={() => setTone(value)} />
              </Fragment>
            ))}
          </Card>

          <GroupHeader title="最初のあいさつ" />
          <View style={styles.greetingBox}>
            <TextInput
              value={greeting}
              onChangeText={setGreeting}
              multiline
              editable={loaded}
              maxLength={GREETING_MAX_LENGTH}
              accessibilityLabel="最初のあいさつ"
              textAlignVertical="top"
              style={styles.greeting}
            />
            <Text style={styles.counter}>{`${Array.from(greeting).length} / ${GREETING_MAX_LENGTH} 字`}</Text>
          </View>

          <GroupHeader title="予約なしのお客様" />
          <Card>
            {WALK_IN_ORDER.map((value, index) => (
              <Fragment key={value}>
                {index > 0 ? <Separator /> : null}
                <RadioRow label={WALK_IN_LABELS[value]} selected={walkIn === value} onPress={() => setWalkIn(value)} />
              </Fragment>
            ))}
          </Card>

          <GroupHeader title="AI への指示" />
          <Card>
            <LinkRow
              label="追加の指示"
              icon={SYMBOLS.instructions}
              value={hasInstructions === null ? undefined : hasInstructions ? '設定済み' : '未設定'}
              onPress={() => router.push('/settings/instructions')}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  greetingBox: { marginHorizontal: 16, gap: 6 },
  greeting: {
    minHeight: 86,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    fontSize: 17,
    lineHeight: 27,
    color: colors.text,
  },
  counter: {
    paddingHorizontal: 16,
    textAlign: 'right',
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
});
