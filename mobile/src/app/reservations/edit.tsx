import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InlineDatePicker } from '../../components/InlineDatePicker';
import { NavBar, Screen } from '../../components/Screen';
import { Card, Chip, ChipGroup, GroupHeader, NavTextButton, Separator, Stepper } from '../../components/ui';
import { newIdempotencyKey, type ReservationInput, startOfDayDate } from '../../domain/reservation';
import type { ShopService } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { clockLabel, endClockLabel, minutesLabel, monthDay } from '../../lib/format';
import { colors, radius } from '../../theme';

const STEP_MINUTES = 15;
const DEFAULT_START = 10 * 60;
const DEFAULT_DURATION = 60;
const MAX_DURATION = 12 * 60;
const LAST_START = 24 * 60 - STEP_MINUTES;

// date は開く日付。時刻が入っていれば開始の初期値にする。name などは自然言語の入力の「修正」から渡す。
// id と一緒に date や duration を渡すと、読み込んだ予約の日時より優先する
type Params = {
  id?: string;
  date?: string;
  name?: string;
  phone?: string;
  service?: string;
  duration?: string;
  note?: string;
};

export default function ReservationEditScreen() {
  const params = useLocalSearchParams<Params>();
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const initial = useMemo(() => (params.date ? new Date(params.date) : new Date()), [params.date]);
  const [loaded, setLoaded] = useState(!params.id);
  const [services, setServices] = useState<ShopService[]>([]);
  const [name, setName] = useState(params.name ?? '');
  const [phone, setPhone] = useState(params.phone ?? '');
  const [serviceName, setServiceName] = useState<string | null>(params.service ?? null);
  const [date, setDate] = useState(startOfDayDate(initial));
  const [dateOpen, setDateOpen] = useState(false);
  const [startMinutes, setStartMinutes] = useState(() => {
    const minutes = initial.getHours() * 60 + initial.getMinutes();
    return params.date && minutes > 0 ? minutes : DEFAULT_START;
  });
  const [duration, setDuration] = useState(params.duration ? Number(params.duration) : DEFAULT_DURATION);
  const [note, setNote] = useState(params.note ?? '');
  const [saving, setSaving] = useState(false);
  // 画面ごとに1つ。保存を押し直しても二重に作らない
  const idempotencyKey = useRef(newIdempotencyKey());

  useEffect(() => {
    repositories.shop
      .listServices(household.id)
      .then(setServices)
      .catch(() => setServices([]));
  }, [household.id]);

  useEffect(() => {
    if (!params.id) return;
    repositories.reservations
      .get(params.id)
      .then((reservation) => {
        const start = new Date(params.date ?? reservation.starts_at);
        const end = new Date(reservation.ends_at);
        setName(reservation.customer_name);
        setPhone(reservation.customer_phone ?? '');
        setServiceName(reservation.service_name);
        setDate(startOfDayDate(start));
        setStartMinutes(start.getHours() * 60 + start.getMinutes());
        setDuration(
          params.duration
            ? Number(params.duration)
            : Math.round((end.getTime() - new Date(reservation.starts_at).getTime()) / 60_000),
        );
        setNote(reservation.note ?? '');
        setLoaded(true);
      })
      .catch((e) => {
        Alert.alert('読み込めませんでした', errorMessage(e) ?? '');
        router.back();
      });
  }, [params.id]);

  function selectService(service: ShopService | null) {
    setServiceName(service?.name ?? null);
    if (service) setDuration(service.duration_minutes);
  }

  function toggleDate() {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: date,
        mode: 'date',
        onValueChange: (_event, next) => setDate(startOfDayDate(next)),
      });
      return;
    }
    setDateOpen((open) => !open);
  }

  async function save() {
    const startsAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, startMinutes);
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);
    const input: ReservationInput = {
      customer_name: name.trim(),
      customer_phone: phone.trim() || null,
      service_name: serviceName,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      note: note.trim() || null,
    };
    setSaving(true);
    try {
      if (params.id) await repositories.reservations.update(params.id, input);
      else await repositories.reservations.create(input, idempotencyKey.current);
      router.back();
    } catch (e) {
      Alert.alert('保存できませんでした', errorMessage(e) ?? '');
    } finally {
      setSaving(false);
    }
  }

  // メニューの表にない名前（Google カレンダーで入れた予定など）も選択肢に残す
  const serviceNames = services.map((service) => service.name);
  const extraService = serviceName && !serviceNames.includes(serviceName) ? serviceName : null;
  const canSave = loaded && !!name.trim() && !saving;

  return (
    <Screen waves={false}>
      <NavBar
        title={params.id ? '予約を編集' : '予約を追加'}
        backLabel="予約"
        onBack={() => router.back()}
        right={<NavTextButton label="保存" disabled={!canSave} loading={saving} onPress={save} />}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled">
          <GroupHeader title="お客様" first />
          <Card>
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>お名前</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={60}
                editable={loaded}
                accessibilityLabel="お名前"
                style={styles.input}
              />
            </View>
            <Separator />
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>電話</Text>
              <TextInput
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                maxLength={30}
                editable={loaded}
                accessibilityLabel="電話"
                style={styles.input}
              />
            </View>
          </Card>

          <GroupHeader title="メニュー" />
          <Card>
            <ChipGroup>
              {services.map((service) => (
                <Chip
                  key={service.id}
                  label={service.name}
                  selected={serviceName === service.name}
                  onPress={() => selectService(service)}
                />
              ))}
              {extraService ? <Chip label={extraService} selected onPress={() => setServiceName(extraService)} /> : null}
              <Chip label="指定なし" selected={serviceName === null} onPress={() => selectService(null)} />
            </ChipGroup>
          </Card>

          <GroupHeader title="日時" />
          <Card>
            <Pressable
              onPress={toggleDate}
              accessibilityRole="button"
              accessibilityLabel={`日付 ${monthDay(date)}`}
              accessibilityState={{ expanded: dateOpen }}
              style={({ pressed }) => [styles.dateRow, pressed && styles.rowPressed]}
            >
              <Text style={styles.rowLabel}>日付</Text>
              <Text style={styles.dateValue}>{monthDay(date)}</Text>
            </Pressable>
            {dateOpen ? (
              <InlineDatePicker
                value={date}
                onSelect={(next) => {
                  setDate(startOfDayDate(next));
                  setDateOpen(false);
                }}
              />
            ) : null}
            <Separator />
            <Stepper
              label="開始"
              value={clockLabel(startMinutes)}
              onDecrease={() => setStartMinutes((value) => Math.max(0, value - STEP_MINUTES))}
              onIncrease={() => setStartMinutes((value) => Math.min(LAST_START, value + STEP_MINUTES))}
            />
            <Separator />
            <Stepper
              label="所要時間"
              value={minutesLabel(duration)}
              onDecrease={() => setDuration((value) => Math.max(STEP_MINUTES, value - STEP_MINUTES))}
              onIncrease={() => setDuration((value) => Math.min(MAX_DURATION, value + STEP_MINUTES))}
            />
            <Separator />
            <View style={styles.dateRow}>
              <Text style={styles.rowLabel}>終了</Text>
              <Text style={styles.endValue}>{endClockLabel(startMinutes + duration)}</Text>
            </View>
          </Card>

          <GroupHeader title="メモ" />
          <View style={styles.noteBox}>
            <TextInput
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={500}
              editable={loaded}
              accessibilityLabel="メモ"
              textAlignVertical="top"
              style={styles.note}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  inputRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  inputLabel: { width: 72, fontSize: 17, color: colors.text },
  input: { flex: 1, minWidth: 0, height: 52, fontSize: 17, color: colors.text },
  dateRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  rowPressed: { backgroundColor: colors.separator },
  rowLabel: { flex: 1, fontSize: 17, color: colors.text },
  dateValue: { fontSize: 17, fontWeight: '600', color: colors.navy },
  endValue: { fontSize: 17, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  noteBox: { marginHorizontal: 16 },
  note: {
    minHeight: 100,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    fontSize: 17,
    lineHeight: 27,
    color: colors.text,
  },
});
