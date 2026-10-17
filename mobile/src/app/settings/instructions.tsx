import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { NavBar, Screen } from '../../components/Screen';
import { getDevice, updateDevice } from '../../lib/api';
import { useHousehold } from '../../lib/auth';
import { errorMessage } from '../../lib/authActions';
import type { Device } from '../../lib/types';
import { colors, radius } from '../../theme';

// 上限字数は未定（house_rules 全体で 800 字以内）。決まったら数を入れる
const MAX_LENGTH: number | null = null;

export default function InstructionsScreen() {
  const household = useHousehold();
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDevice(household.id)
      .then((d) => {
        setDevice(d);
        setText(d?.extra_instructions ?? '');
      })
      .catch((e) => {
        setDevice(null);
        Alert.alert('読み込めませんでした', errorMessage(e) ?? '');
      });
  }, [household.id]);

  async function save() {
    if (!device) return;
    setSaving(true);
    try {
      await updateDevice(device.id, { extra_instructions: text.trim() });
      router.back();
    } catch (e) {
      Alert.alert('保存できませんでした', errorMessage(e) ?? '');
    } finally {
      setSaving(false);
    }
  }

  const length = Array.from(text).length;

  return (
    <Screen>
      <NavBar
        title="追加の指示"
        backLabel="設定"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={save}
            disabled={!device || saving}
            accessibilityRole="button"
            style={({ pressed }) => [styles.save, (pressed || !device) && styles.dim]}
          >
            {saving ? <ActivityIndicator color={colors.navy} /> : <Text style={styles.saveLabel}>保存</Text>}
          </Pressable>
        }
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.label} nativeID="instructions-label">
            指示
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            editable={!!device}
            maxLength={MAX_LENGTH ?? undefined}
            accessibilityLabel="指示"
            accessibilityLabelledBy="instructions-label"
            textAlignVertical="top"
            style={styles.input}
          />
          <Text style={styles.counter}>{MAX_LENGTH ? `${length} / ${MAX_LENGTH} 字` : `${length} 字`}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  save: { height: 44, paddingHorizontal: 8, justifyContent: 'center' },
  saveLabel: { fontSize: 17, fontWeight: '600', color: colors.navy },
  dim: { opacity: 0.5 },
  content: { marginTop: 16, marginHorizontal: 16, gap: 6 },
  label: { paddingHorizontal: 16, fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  input: {
    minHeight: 246,
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
