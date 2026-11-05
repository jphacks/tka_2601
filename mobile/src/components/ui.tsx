import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  type SwitchProps,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { SymbolName } from '../lib/symbols';
import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { Check, ChevronRight } from './icons';

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  // 2つ並べてカードに置くときの小さい形
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

// 紺の塗りのボタン（ログイン、グループを作る、参加する など）
export function PrimaryButton({ label, onPress, disabled, loading, icon, compact, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        styles.row,
        compact && styles.compact,
        { backgroundColor: pressed ? colors.navyPressed : colors.navy },
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <>
          {icon}
          <Text style={[styles.buttonLabel, compact && styles.compactLabel, { color: '#FFFFFF' }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

// 薄い紺の地のボタン（QR コードを読み取る）
export function TintButton({ label, onPress, disabled, loading, icon, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        styles.row,
        { backgroundColor: colors.navyTint },
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={colors.navy} /> : icon}
      <Text style={[styles.buttonLabel, { color: colors.navy }]}>{label}</Text>
    </Pressable>
  );
}

// 地のない紺の文字のボタン（参加しない）
export function TextButton({ label, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled, style]}
    >
      <Text style={[styles.buttonLabel, { color: colors.navy }]}>{label}</Text>
    </Pressable>
  );
}

type FieldProps = TextInputProps & { label: string };

// 上にラベルを置いた入力欄
export function TextField({ label, style, ...input }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} nativeID={`label-${label}`}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.placeholder}
        style={[styles.input, style]}
        {...input}
      />
    </View>
  );
}

// 白い角丸の箱（リストのまとまり）
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Separator({ inset = 16 }: { inset?: number }) {
  return <View style={[styles.separator, { marginLeft: inset }]} />;
}

// 設定の見出し（13px、灰）
export function GroupHeader({ title, first }: { title: string; first?: boolean }) {
  return (
    <Text style={[styles.groupHeader, first && { paddingTop: 20 }]} accessibilityRole="header">
      {title}
    </Text>
  );
}

// タブの大見出し。右のボタンの有無によらず、どのタブでも同じ高さにする
export function LargeTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.titleRow}>
      <Text style={styles.largeTitle} accessibilityRole="header">
        {title}
      </Text>
      {right}
    </View>
  );
}

// 設定の行の左に置く紺の角丸
export function SettingIcon({ name }: { name: SymbolName }) {
  return (
    <View style={styles.settingIcon}>
      <Icon name={name} size={19} color="#FFFFFF" />
    </View>
  );
}

// iOS の Switch は既定で alignSelf: flex-start なので、行の中央に戻す
export function RowSwitch(props: SwitchProps) {
  return <Switch {...props} style={styles.rowSwitch} trackColor={{ true: colors.navy }} />;
}

// 一覧の行の左に置く丸。filled で紺に塗る
export function RoundIcon({ name, filled }: { name: SymbolName; filled?: boolean }) {
  return (
    <View style={[styles.roundIcon, filled && { backgroundColor: colors.navy }]}>
      <Icon name={name} size={19} color={filled ? '#FFFFFF' : colors.navy} />
    </View>
  );
}

// 右に値と > を出す行（設定の「追加の指示」「グループ」）
export function LinkRow({
  label,
  value,
  icon,
  onPress,
  labelColor = colors.text,
}: {
  label: string;
  value?: string;
  icon?: SymbolName;
  onPress: () => void;
  labelColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.linkRow, icon && styles.iconRow, pressed && styles.rowPressed]}
    >
      {icon ? <SettingIcon name={icon} /> : null}
      <Text style={[styles.rowLabel, { color: labelColor }]}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      <ChevronRight />
    </Pressable>
  );
}

// 1つだけ選ぶ行（右に紺のチェック）
export function RadioRow({
  label,
  value,
  icon,
  selected,
  onPress,
  disabled = false,
}: {
  label: string;
  value?: string;
  icon?: SymbolName;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={value ? `${label}、${value}` : label}
      accessibilityState={{ checked: selected, disabled }}
      style={({ pressed }) => [styles.radioRow, icon && styles.iconRow, pressed && styles.rowPressed, disabled && styles.disabled]}
    >
      {icon ? <SettingIcon name={icon} /> : null}
      <Text style={[styles.radioLabel, selected && styles.radioSelected]}>{label}</Text>
      {value ? <Text style={styles.radioValue}>{value}</Text> : null}
      <View style={styles.radioCheck}>{selected ? <Check /> : null}</View>
    </Pressable>
  );
}

// 左にラベル、右に値を出す行
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// 左にラベル、右に − 値 + を並べる行。時刻や所要時間を決まった刻みで変える
export function Stepper({
  label,
  value,
  onDecrease,
  onIncrease,
  disabled,
  compact,
}: {
  label: string;
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
  disabled?: boolean;
  // 行の内側に置くとき、左右の余白を親に任せる
  compact?: boolean;
}) {
  return (
    <View style={[styles.stepperRow, compact && styles.stepperCompact, disabled && styles.disabled]}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <Pressable
        onPress={onDecrease}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}を減らす`}
        style={({ pressed }) => [styles.stepperButton, pressed && styles.pressed]}
      >
        <Text style={styles.stepperSign}>−</Text>
      </Pressable>
      <Text style={styles.stepperValue} accessibilityLabel={`${label} ${value}`}>
        {value}
      </Text>
      <Pressable
        onPress={onIncrease}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}を増やす`}
        style={({ pressed }) => [styles.stepperButton, pressed && styles.pressed]}
      >
        <Text style={styles.stepperSign}>+</Text>
      </Pressable>
    </View>
  );
}

// 丸い選択肢（メニュー、業種）
export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

export function ChipGroup({ children }: { children: ReactNode }) {
  return <View style={styles.chipGroup}>{children}</View>;
}

// ナビゲーションバーの右の文字のボタン（保存、追加、編集）
export function NavTextButton({
  label,
  onPress,
  disabled,
  loading,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [styles.navButton, (pressed || disabled) && styles.pressed]}
    >
      {loading ? <ActivityIndicator color={colors.navy} /> : <Text style={styles.navButtonLabel}>{label}</Text>}
    </Pressable>
  );
}

// 左に項目名、右に値を並べる表（予約の詳細、確認カード）
export function DefinitionList({ rows }: { rows: { label: string; value: ReactNode; strong?: boolean }[] }) {
  return (
    <View style={styles.definitions}>
      {rows.map((row) => (
        <View key={row.label} style={styles.definitionRow}>
          <Text style={styles.definitionLabel}>{row.label}</Text>
          {typeof row.value === 'string' ? (
            <Text style={[styles.definitionValue, row.strong && styles.definitionStrong]}>{row.value}</Text>
          ) : (
            <View style={styles.definitionSlot}>{row.value}</View>
          )}
        </View>
      ))}
    </View>
  );
}

// 薄い紺の地に紺の文字のボタン。2つ並べるときに使う
export function SoftButton({ label, onPress, disabled, icon, compact, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        styles.row,
        compact && styles.compact,
        { backgroundColor: colors.navyTint },
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {icon}
      <Text style={[styles.buttonLabel, compact && styles.compactLabel, { color: colors.navy }]}>{label}</Text>
    </Pressable>
  );
}

// 意図の札。緊急だけ紺で塗る
export function IntentBadge({ label, emphasis }: { label: string; emphasis?: boolean }) {
  return (
    <View style={[styles.badge, emphasis && { backgroundColor: colors.navy }]}>
      <Text style={[styles.badgeText, emphasis && { color: '#FFFFFF' }]}>{label}</Text>
    </View>
  );
}

// 読み込み中や空のときに中央へ出す文字
export function CenterMessage({ children }: { children: ReactNode }) {
  return (
    <View style={styles.center}>
      {typeof children === 'string' ? <Text style={styles.centerText}>{children}</Text> : children}
    </View>
  );
}

export const shared = StyleSheet.create({
  pressed: { opacity: 0.5 },
  errorText: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.navy,
    textAlign: 'center',
  },
});

const styles = StyleSheet.create({
  rowSwitch: { alignSelf: 'center' },
  button: {
    height: 50,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', gap: 8 },
  compact: { height: 46, gap: 6 },
  buttonLabel: { fontSize: 17, fontWeight: '600' },
  compactLabel: { fontSize: 16 },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
  field: { gap: 6 },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    paddingLeft: 4,
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.button,
    paddingHorizontal: 14,
    fontSize: 17,
    backgroundColor: colors.card,
    color: colors.text,
  },
  card: {
    marginHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  separator: { height: 1, backgroundColor: colors.separator },
  titleRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 4,
    paddingLeft: 20,
    paddingRight: 16,
  },
  largeTitle: { flex: 1, fontSize: 34, fontWeight: '700', color: colors.text },
  settingIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.navy,
  },
  roundIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.navyTint,
  },
  // 左に札を置く行。区切り線の字下げは 56
  iconRow: { gap: 12, paddingLeft: 14, paddingRight: 12 },
  groupHeader: {
    paddingTop: 18,
    paddingHorizontal: 32,
    paddingBottom: 7,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  linkRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 12,
  },
  rowPressed: { backgroundColor: colors.separator },
  rowLabel: { flex: 1, fontSize: 17 },
  rowValue: { fontSize: 17, color: colors.textSecondary },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderRadius: radius.badge,
    backgroundColor: colors.navyTint,
  },
  badgeText: {
    fontSize: 12,
    lineHeight: 19,
    fontWeight: '700',
    color: colors.navy,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 52,
  },
  radioLabel: { flex: 1, fontSize: 17, color: colors.text },
  radioSelected: { fontWeight: '600' },
  radioValue: { fontSize: 15, color: colors.textSecondary },
  radioCheck: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  infoRow: { minHeight: 46, flexDirection: 'row', gap: 16, paddingVertical: 12, paddingHorizontal: 16 },
  infoLabel: { fontSize: 15, lineHeight: 22, color: colors.textSecondary },
  infoValue: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.text, textAlign: 'right' },
  stepperRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 12 },
  stepperCompact: { minHeight: 52, paddingLeft: 0, paddingRight: 0 },
  stepperLabel: { flex: 1, fontSize: 17, color: colors.text },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.navyTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperSign: { fontSize: 22, fontWeight: '600', color: colors.navy },
  stepperValue: {
    width: 64,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  chipGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: colors.navyTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.navy },
  chipLabel: { fontSize: 15, fontWeight: '600', color: colors.navy },
  chipLabelSelected: { color: '#FFFFFF' },
  navButton: { minWidth: 44, height: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  navButtonLabel: { fontSize: 17, fontWeight: '600', color: colors.navy },
  definitions: { gap: 10 },
  definitionRow: { flexDirection: 'row', gap: 12 },
  definitionLabel: { width: 88, fontSize: 15, lineHeight: 22, color: colors.textSecondary },
  definitionValue: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.text, fontVariant: ['tabular-nums'] },
  definitionStrong: { fontWeight: '600' },
  definitionSlot: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  centerText: { fontSize: 15, lineHeight: 22, color: colors.textSecondary, textAlign: 'center' },
});
