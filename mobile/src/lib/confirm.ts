import { Alert } from 'react-native';

// OS の確認ダイアログを出し、確定を押したときだけ実行する
export function confirmAction({
  title,
  confirmLabel,
  cancelLabel = 'キャンセル',
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
}) {
  Alert.alert(title, undefined, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, onPress: onConfirm },
  ]);
}
