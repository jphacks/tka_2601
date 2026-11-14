import SegmentedControlClass from '@react-native-segmented-control/segmented-control';
import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

type Props = {
  values: string[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  style?: StyleProp<ViewStyle>;
};

// ライブラリの型は今の React Native の型と合わず、JSX に使えない
type NativeProps = {
  values: string[];
  selectedIndex: number;
  onChange: (event: { nativeEvent: { selectedSegmentIndex: number } }) => void;
  style?: StyleProp<ViewStyle>;
};
const NativeSegmentedControl = SegmentedControlClass as unknown as ComponentType<NativeProps>;

// iOS の分割ボタン
export function SegmentedControl({ values, selectedIndex, onSelect, style }: Props) {
  return (
    <NativeSegmentedControl
      values={values}
      selectedIndex={selectedIndex}
      onChange={(event) => onSelect(event.nativeEvent.selectedSegmentIndex)}
      style={style}
    />
  );
}
