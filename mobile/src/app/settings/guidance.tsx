import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { NavBar, Screen } from '../../components/Screen';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { colors, radius } from '../../theme';

// ボイスバックエンドの案内文の上限
const MAX_LENGTH = 300;

export default function GuidanceScreen() {
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    repositories.reception
      .getGuidance()
      .then((guidance) => {
        setText(guidance);
        setLoaded(true);
      })
      .catch((e) => Alert.alert('読み込めませんでした', errorMessage(e) ?? ''));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await repositories.reception.saveGuidance(text.trim());
      router.back();
    } catch (e) {
      Alert.alert('保存できませんでした', errorMessage(e) ?? '');
    } finally {
      setSaving(false);
    }
  }

  const length = Array.from(text).length;
  // 空の案内文は受け付けない
  const canSave = loaded && !saving && text.trim().length > 0;

  return (
    <Screen>
      <NavBar
        title="案内文"
        backLabel="受付"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={save}
            disabled={!canSave}
            accessibilityRole="button"
            style={({ pressed }) => [styles.save, (pressed || !canSave) && styles.dim]}
          >
            {saving ? <ActivityIndicator color={colors.navy} /> : <Text style={styles.saveLabel}>保存</Text>}
          </Pressable>
        }
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.label} nativeID="guidance-label">
            案内文
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            editable={loaded}
            maxLength={MAX_LENGTH}
            accessibilityLabel="案内文"
            accessibilityLabelledBy="guidance-label"
            textAlignVertical="top"
            style={styles.input}
          />
          <Text style={styles.counter}>{`${length} / ${MAX_LENGTH} 字`}</Text>
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
