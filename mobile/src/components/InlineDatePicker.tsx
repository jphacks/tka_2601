import DateTimePicker from '@react-native-community/datetimepicker';

import { colors } from '../theme';

// 日付を選ぶカレンダー（iOS）。選んだらその日を返す
export function InlineDatePicker({ value, onSelect }: { value: Date; onSelect: (date: Date) => void }) {
  return (
    <DateTimePicker
      value={value}
      mode="date"
      display="inline"
      locale="ja-JP"
      accentColor={colors.navy}
      themeVariant="light"
      onValueChange={(_event, next) => onSelect(next)}
    />
  );
}
