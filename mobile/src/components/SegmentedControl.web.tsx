import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '../theme';

type Props = {
  values: string[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  style?: StyleProp<ViewStyle>;
};

// Web には分割ボタンがないので、同じ形を描く
export function SegmentedControl({ values, selectedIndex, onSelect, style }: Props) {
  return (
    <View style={[styles.track, style]} accessibilityRole="tablist">
      {values.map((label, index) => {
        const selected = index === selectedIndex;
        return (
          <Pressable
            key={label}
            onPress={() => onSelect(index)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.segment, selected && styles.selected]}
          >
            <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: 32,
    padding: 2,
    borderRadius: 9,
    backgroundColor: 'rgba(118, 118, 128, 0.12)',
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  selected: { backgroundColor: colors.card },
  label: { fontSize: 13, fontWeight: '500', color: colors.text },
  labelSelected: { fontWeight: '600' },
});
