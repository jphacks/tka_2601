import { createElement } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '../theme';

function toInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Web ではブラウザの日付の入力を出す。選んだらその日を返す
export function InlineDatePicker({ value, onSelect }: { value: Date; onSelect: (date: Date) => void }) {
  return (
    <View style={styles.box}>
      {createElement('input', {
        type: 'date',
        value: toInputValue(value),
        'aria-label': '日付',
        onChange: (event: { target: { value: string } }) => {
          const [year, month, day] = event.target.value.split('-').map(Number);
          if (year && month && day) onSelect(new Date(year, month - 1, day));
        },
        style: {
          height: 44,
          padding: '0 12px',
          fontSize: 17,
          borderRadius: 10,
          border: `1px solid ${colors.border}`,
          color: colors.text,
          fontFamily: 'inherit',
        },
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 16, paddingBottom: 12, alignItems: 'flex-start' },
});
