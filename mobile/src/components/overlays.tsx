import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../theme';

type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

// デザインどおりに描いた確認ダイアログ（OS の Alert は色を紺にできないため）
export function ConfirmDialog({
  visible,
  title,
  confirmLabel,
  cancelLabel = 'キャンセル',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.dim}>
        <View style={styles.dialog} accessibilityRole="alert" accessibilityViewIsModal>
          <View style={styles.dialogBody}>
            <Text style={styles.dialogTitle}>{title}</Text>
          </View>
          <View style={styles.dialogButtons}>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              style={({ pressed }) => [styles.dialogButton, styles.dialogButtonLeft, pressed && styles.pressedFill]}
            >
              <Text style={styles.dialogButtonText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              accessibilityRole="button"
              style={({ pressed }) => [styles.dialogButton, pressed && styles.pressedFill]}
            >
              <Text style={[styles.dialogButtonText, styles.bold]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

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
  dim: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialog: {
    width: 270,
    borderRadius: 14,
    backgroundColor: colors.dialog,
    overflow: 'hidden',
  },
  dialogBody: { paddingVertical: 20, paddingHorizontal: 16 },
  dialogTitle: { fontSize: 17, fontWeight: '600', textAlign: 'center', color: colors.text },
  dialogButtons: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.dialogBorder,
  },
  dialogButton: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  dialogButtonLeft: { borderRightWidth: 1, borderRightColor: colors.dialogBorder },
  dialogButtonText: { fontSize: 17, color: colors.navy },
  bold: { fontWeight: '600' },
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
