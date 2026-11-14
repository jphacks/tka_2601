import { router } from 'expo-router';
import { Fragment, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, Chip, ChipGroup, GroupHeader, NavTextButton, RowSwitch, Separator, Stepper } from '../../components/ui';
import { type BusinessHour, type BusinessType, normalizeBusinessHours } from '../../domain/shop';
import { useAuth, useHousehold } from '../../lib/auth';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { clockLabel, clockMinutes } from '../../lib/format';
import { BUSINESS_TYPE_LABELS, BUSINESS_TYPE_ORDER } from '../../lib/labels';
import { colors, radius } from '../../theme';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
// 営業時間は月曜から並べる
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const STEP_MINUTES = 30;

export default function ShopScreen() {
  const household = useHousehold();
  const { refreshMembership } = useAuth();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(household.name);
  const [businessType, setBusinessType] = useState<BusinessType>('other');
  const [hours, setHours] = useState<BusinessHour[]>(normalizeBusinessHours([]));
  const [expanded, setExpanded] = useState<number | null>(DISPLAY_ORDER[0]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    repositories.shop
      .getProfile(household.id)
      .then((profile) => {
        if (profile) {
          setBusinessType(profile.business_type);
          setHours(normalizeBusinessHours(profile.business_hours));
          setLoaded(true);
        } else {
          Alert.alert('読み込めませんでした');
        }
      })
      .catch((e) => Alert.alert('読み込めませんでした', errorMessage(e) ?? ''));
  }, [household.id]);

  function changeHour(day: number, patch: Partial<BusinessHour>) {
    setHours((current) => current.map((row) => (row.day === day ? { ...row, ...patch } : row)));
  }

  // 開店は閉店より前、閉店は開店より後に収める
  function stepOpen(row: BusinessHour, delta: number) {
    const close = clockMinutes(row.close, 19 * 60);
    const next = Math.min(Math.max(clockMinutes(row.open, 10 * 60) + delta, 0), close - STEP_MINUTES);
    changeHour(row.day, { open: clockLabel(next) });
  }

  function stepClose(row: BusinessHour, delta: number) {
    const open = clockMinutes(row.open, 10 * 60);
    const next = Math.max(Math.min(clockMinutes(row.close, 19 * 60) + delta, 24 * 60), open + STEP_MINUTES);
    changeHour(row.day, { close: clockLabel(next) });
  }

  async function save() {
    setSaving(true);
    try {
      await repositories.shop.updateProfile(household.id, { business_type: businessType, business_hours: hours });
      if (name.trim() !== household.name) {
        await repositories.shop.rename(household.id, name.trim());
        await refreshMembership();
      }
      router.back();
    } catch (e) {
      Alert.alert('保存できませんでした', errorMessage(e) ?? '');
    } finally {
      setSaving(false);
    }
  }

  const canSave = loaded && !!name.trim() && !saving;

  return (
    <Screen waves={false}>
      <NavBar
        title="店舗情報"
        backLabel="設定"
        onBack={() => router.back()}
        right={<NavTextButton label="保存" disabled={!canSave} loading={saving} onPress={save} />}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <GroupHeader title="店名" first />
          <View style={styles.nameBox}>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={60}
              accessibilityLabel="店名"
              style={styles.name}
            />
          </View>

          <GroupHeader title="業種" />
          <Card>
            <ChipGroup>
              {BUSINESS_TYPE_ORDER.map((type) => (
                <Chip
                  key={type}
                  label={BUSINESS_TYPE_LABELS[type]}
                  selected={businessType === type}
                  onPress={() => setBusinessType(type)}
                />
              ))}
            </ChipGroup>
          </Card>

          <GroupHeader title="営業時間" />
          <Card>
            {DISPLAY_ORDER.map((day, index) => {
              const row = hours[day];
              const label = WEEKDAY_LABELS[day];
              const open = expanded === day;
              return (
                <Fragment key={day}>
                  {index > 0 ? <Separator /> : null}
                  <Pressable
                    onPress={() => setExpanded(open ? null : day)}
                    accessibilityRole="button"
                    accessibilityLabel={`${label}曜日、${row.closed ? '定休日' : `${row.open}から${row.close}`}`}
                    accessibilityState={{ expanded: open }}
                    style={({ pressed }) => [styles.dayRow, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.dayLabel}>{label}</Text>
                    <Text style={[styles.dayValue, row.closed && styles.dayClosed]}>
                      {row.closed ? '定休日' : `${row.open}〜${row.close}`}
                    </Text>
                  </Pressable>
                  {open ? (
                    <View style={styles.dayDetail}>
                      <View style={styles.closedRow}>
                        <Text style={styles.closedLabel}>定休日</Text>
                        <RowSwitch
                          accessibilityLabel={`${label}曜日を定休日にする`}
                          value={row.closed}
                          onValueChange={(closed) => changeHour(day, { closed })}
                        />
                      </View>
                      {row.closed ? null : (
                        <>
                          <Stepper
                            compact
                            label="開店"
                            value={row.open}
                            onDecrease={() => stepOpen(row, -STEP_MINUTES)}
                            onIncrease={() => stepOpen(row, STEP_MINUTES)}
                          />
                          <Stepper
                            compact
                            label="閉店"
                            value={row.close}
                            onDecrease={() => stepClose(row, -STEP_MINUTES)}
                            onIncrease={() => stepClose(row, STEP_MINUTES)}
                          />
                        </>
                      )}
                    </View>
                  ) : null}
                </Fragment>
              );
            })}
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  nameBox: { marginHorizontal: 16 },
  name: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    fontSize: 17,
    color: colors.text,
  },
  dayRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  rowPressed: { backgroundColor: colors.separator },
  dayLabel: { width: 24, fontSize: 17, fontWeight: '600', color: colors.text },
  dayValue: { flex: 1, textAlign: 'right', fontSize: 17, color: colors.text, fontVariant: ['tabular-nums'] },
  dayClosed: { color: colors.textSecondary },
  dayDetail: { paddingLeft: 16, paddingRight: 12, paddingBottom: 8 },
  closedRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 },
  closedLabel: { flex: 1, fontSize: 17, color: colors.text },
});
