import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmDialog } from '../../components/overlays';
import { NavBar, Screen } from '../../components/Screen';
import { Card, NavTextButton, Separator, Stepper, TextButton } from '../../components/ui';
import { useHousehold } from '../../lib/auth';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { minutesLabel } from '../../lib/format';
import { colors } from '../../theme';

const STEP_MINUTES = 15;
const MIN_DURATION = 15;
const MAX_DURATION = 12 * 60;

// メニューの追加と編集。id があれば編集、なければ order の位置に追加する
export default function ServiceEditScreen() {
  const { id, order } = useLocalSearchParams<{ id?: string; order?: string }>();
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState(!id);
  const [savedName, setSavedName] = useState('');
  const [name, setName] = useState('');
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    repositories.shop
      .listServices(household.id)
      .then((services) => {
        const service = services.find((row) => row.id === id);
        if (!service) throw new Error('メニューが見つかりません');
        setSavedName(service.name);
        setName(service.name);
        setDuration(service.duration_minutes);
        setPrice(service.price_yen !== null ? String(service.price_yen) : '');
        setLoaded(true);
      })
      .catch((e) => {
        Alert.alert('読み込めませんでした', errorMessage(e) ?? '');
        router.back();
      });
  }, [id, household.id]);

  async function save() {
    const digits = price.replace(/[^0-9]/g, '');
    const input = {
      name: name.trim(),
      duration_minutes: duration,
      price_yen: digits ? Number(digits) : null,
    };
    setSaving(true);
    try {
      if (id) await repositories.shop.updateService(id, input);
      else await repositories.shop.createService(household.id, input, Number(order ?? 0));
      router.back();
    } catch (e) {
      Alert.alert('保存できませんでした', errorMessage(e) ?? '');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id) return;
    setConfirmOpen(false);
    try {
      await repositories.shop.removeService(id);
      router.back();
    } catch (e) {
      Alert.alert('削除できませんでした', errorMessage(e) ?? '');
    }
  }

  const canSave = loaded && !!name.trim() && !saving;

  return (
    <Screen>
      <NavBar
        title={id ? savedName : 'メニューを追加'}
        backLabel="メニュー"
        onBack={() => router.back()}
        right={<NavTextButton label="保存" disabled={!canSave} loading={saving} onPress={save} />}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Card>
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>名前</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={40}
                editable={loaded}
                accessibilityLabel="名前"
                style={styles.input}
              />
            </View>
            <Separator />
            <Stepper
              label="所要時間"
              value={minutesLabel(duration)}
              onDecrease={() => setDuration((value) => Math.max(MIN_DURATION, value - STEP_MINUTES))}
              onIncrease={() => setDuration((value) => Math.min(MAX_DURATION, value + STEP_MINUTES))}
            />
            <Separator />
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>料金</Text>
              <TextInput
                value={price}
                onChangeText={setPrice}
                keyboardType="number-pad"
                maxLength={7}
                editable={loaded}
                accessibilityLabel="料金"
                style={[styles.input, styles.price]}
              />
              <Text style={styles.unit}>円</Text>
            </View>
          </Card>
        </ScrollView>
        {id ? (
          <TextButton
            label="このメニューを削除"
            onPress={() => setConfirmOpen(true)}
            style={[styles.remove, { marginBottom: insets.bottom }]}
          />
        ) : null}
      </KeyboardAvoidingView>
      <ConfirmDialog
        visible={confirmOpen}
        title="このメニューを削除しますか"
        confirmLabel="削除"
        cancelLabel="戻る"
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingTop: 16, paddingBottom: 16 },
  inputRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  inputLabel: { width: 72, fontSize: 17, color: colors.text },
  input: { flex: 1, minWidth: 0, height: 52, fontSize: 17, color: colors.text },
  price: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  unit: { fontSize: 17, color: colors.textSecondary },
  remove: { marginHorizontal: 16 },
});
