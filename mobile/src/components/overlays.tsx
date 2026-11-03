import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../theme';

type MenuItem = { label: string; onPress: () => void };

// ナビバー右上の「…」から開くメニュー
export function MenuPopover({
  visible,
  items,
  onClose,
}: {
  visible: boolean;
  items: MenuItem[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.menuDim} onPress={onClose} accessibilityLabel="メニューを閉じる" />
      <View style={[styles.menu, { top: insets.top + 45 }]} accessibilityRole="menu">
        {items.map((item, index) => (
          <Pressable
            key={item.label}
            onPress={item.onPress}
            accessibilityRole="menuitem"
            style={({ pressed }) => [
              styles.menuItem,
              index > 0 && styles.menuItemBorder,
              pressed && styles.pressedFill,
            ]}
          >
            <Text style={styles.menuItemText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pressedFill: { backgroundColor: 'rgba(0, 0, 0, 0.06)' },
  menuDim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0, 0, 0, 0.08)' },
  menu: {
    position: 'absolute',
    right: 12,
    width: 240,
    borderRadius: 13,
    backgroundColor: colors.menu,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  menuItem: { height: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 13 },
  menuItemBorder: { borderTopWidth: 1, borderTopColor: colors.separator },
  menuItemText: { fontSize: 17, color: colors.navy },
});
