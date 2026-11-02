import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

// 予約タブの下の入力欄。押すと入力の画面を開く
export function AssistantBar({ onPress }: { onPress: () => void }) {
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="予約や設定を入力"
        style={({ pressed }) => [styles.field, pressed && styles.pressed]}
      >
        <Text style={styles.placeholder}>予約や設定を入力</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  field: {
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 22,
    backgroundColor: colors.card,
  },
  pressed: { opacity: 0.6 },
  placeholder: { fontSize: 16, color: colors.textSecondary },
});
