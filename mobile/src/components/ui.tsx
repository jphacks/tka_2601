import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, radius } from '../theme';
import { ChevronRight } from './icons';

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

// 紺の塗りのボタン（ログイン、グループを作る、参加する など）
export function PrimaryButton({ label, onPress, disabled, loading, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: pressed ? colors.navyPressed : colors.navy },
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text style={[styles.buttonLabel, { color: '#FFFFFF' }]}>{label}</Text>
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

// 右に値と > を出す行（設定の「追加の指示」「グループ」）
export function LinkRow({
  label,
  value,
  onPress,
  labelColor = colors.text,
}: {
  label: string;
  value?: string;
  onPress: () => void;
  labelColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.linkRow, pressed && styles.rowPressed]}
    >
      <Text style={[styles.rowLabel, { color: labelColor }]}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      <ChevronRight />
    </Pressable>
  );
}

// iOS の形に合わせて描いたスイッチ（51×31）
export function Toggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      style={[
        styles.toggle,
        {
          backgroundColor: value ? colors.navy : colors.switchOff,
          justifyContent: value ? 'flex-end' : 'flex-start',
        },
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.knob} />
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
  button: {
    height: 50,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', gap: 8 },
  buttonLabel: { fontSize: 17, fontWeight: '600' },
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
  groupHeader: {
    paddingTop: 24,
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
  toggle: {
    width: 51,
    height: 31,
    borderRadius: 16,
    padding: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  knob: {
    width: 27,
    height: 27,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 2 },
  },
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  centerText: { fontSize: 15, lineHeight: 22, color: colors.textSecondary, textAlign: 'center' },
});
