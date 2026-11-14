import { Alert, type AlertButton } from 'react-native';

// react-native-web の Alert は何も出さないので、ブラウザのダイアログで代わりに出す
// ボタンが2つ以上あるときは確認（OK で最後のボタン、キャンセルで cancel のボタン）、1つ以下は通知
Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  const text = message ? `${title}\n\n${message}` : title;
  const list = buttons ?? [];
  if (list.length < 2) {
    window.alert(text);
    list[0]?.onPress?.();
    return;
  }
  const cancel = list.find((button) => button.style === 'cancel');
  const action = list.filter((button) => button !== cancel).pop();
  if (window.confirm(text)) action?.onPress?.();
  else cancel?.onPress?.();
};

// アイコンのフォント（Icon.web.tsx が使う）
const font = document.createElement('link');
font.rel = 'stylesheet';
font.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined';
document.head.appendChild(font);
