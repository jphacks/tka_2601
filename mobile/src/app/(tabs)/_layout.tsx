import { Tabs } from 'expo-router/js-tabs';
import { StyleSheet, Text, View } from 'react-native';

import { useBadges } from '../../lib/badges';
import { colors } from '../../theme';

// 文字だけのタブ。数字は文字の右に並べる
function TabLabel({ title, focused, count }: { title: string; focused: boolean; count?: number }) {
  return (
    <View style={styles.label}>
      <Text style={[styles.title, focused && styles.titleFocused]}>{title}</Text>
      {count ? (
        <View style={styles.badge} accessibilityLabel={`${count}件`}>
          <Text style={styles.badgeText}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function TabsLayout() {
  const { unread, pending, refresh } = useBadges();
  return (
    <Tabs
      screenListeners={{ focus: refresh }}
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.separator },
        tabBarIconStyle: { display: 'none' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: '予約', tabBarLabel: ({ focused }) => <TabLabel title="予約" focused={focused} count={pending} /> }}
      />
      <Tabs.Screen
        name="visits"
        options={{ title: '来客', tabBarLabel: ({ focused }) => <TabLabel title="来客" focused={focused} /> }}
      />
      <Tabs.Screen
        name="notifications"
        options={{ title: '通知', tabBarLabel: ({ focused }) => <TabLabel title="通知" focused={focused} count={unread} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: '設定', tabBarLabel: ({ focused }) => <TabLabel title="設定" focused={focused} /> }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { fontSize: 15, color: colors.textSecondary },
  titleFocused: { fontWeight: '700', color: colors.navy },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: colors.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, lineHeight: 18, fontWeight: '700', color: '#FFFFFF' },
});
