import { type Href, router, usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useBadges } from '../lib/badges';
import { SYMBOLS, type SymbolName } from '../lib/symbols';
import { colors } from '../theme';
import { Icon } from './Icon';
import { NotificationToast } from './NotificationToast.web';

// 幅がこれ以上のときは左にナビを置き、狭いときは下に置く
const WIDE = 760;
const CONTENT_MAX = 720;
const VISIT_DETAIL_MAX = 1040;
const SIGNED_OUT_MAX = 480;

type NavItem = {
  label: string;
  href: Href;
  symbol: SymbolName;
  // この道筋で始まる画面にいるときは、この項目を選んだ状態にする
  paths: string[];
  badge?: number;
};

// Web にはネイティブのタブバーがないので、タブの外の画面（詳細や設定の下位）にも同じナビを出す
export function WebShell({ show, children }: { show: boolean; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const { unread, pending } = useBadges();
  if (!show) {
    return (
      <View style={styles.contentOuter}>
        <View style={[styles.content, { maxWidth: SIGNED_OUT_MAX }]}>{children}</View>
      </View>
    );
  }

  const wide = width >= WIDE;
  // 来客詳細だけ、概要と会話を並べるための幅を取る。
  const contentMax = /^\/visits\/[^/]+\/?$/.test(pathname) ? VISIT_DETAIL_MAX : CONTENT_MAX;
  const items: NavItem[] = [
    { label: '予約', href: '/', symbol: SYMBOLS.calendar, paths: ['/', '/reservations', '/assistant'], badge: pending },
    { label: '来客', href: '/visits', symbol: SYMBOLS.people, paths: ['/visits'] },
    { label: '通知', href: '/notifications', symbol: SYMBOLS.bell, paths: ['/notifications'], badge: unread },
    { label: '設定', href: '/settings', symbol: SYMBOLS.service, paths: ['/settings'] },
  ];
  const active = (item: NavItem) =>
    item.paths.some((path) => (path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)));

  const nav = (
    <View style={wide ? styles.sidebar : styles.bottomBar} accessibilityRole="navigation">
      {wide ? <Text style={styles.brand}>MONBAN</Text> : null}
      {items.map((item) => {
        const selected = active(item);
        return (
          <Pressable
            key={item.label}
            onPress={() => router.navigate(item.href)}
            accessibilityRole="link"
            accessibilityState={{ selected }}
            style={[wide ? styles.sideItem : styles.bottomItem, selected && wide && styles.sideItemSelected]}
          >
            <Icon name={item.symbol} size={22} color={selected ? colors.navy : colors.textSecondary} />
            <Text style={[styles.itemLabel, selected && styles.itemLabelSelected]}>{item.label}</Text>
            {item.badge ? (
              <View style={[styles.badge, !wide && styles.badgeFloat]}>
                <Text style={styles.badgeText}>{item.badge}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={[styles.root, !wide && styles.rootNarrow]}>
      {wide ? nav : null}
      <View style={styles.contentOuter}>
        <View style={[styles.content, wide && { maxWidth: contentMax }]}>{children}</View>
      </View>
      {wide ? null : nav}
      <NotificationToast />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  rootNarrow: { flexDirection: 'column' },
  contentOuter: { flex: 1, alignItems: 'center' },
  content: { flex: 1, width: '100%' },
  sidebar: {
    width: 220,
    paddingTop: 28,
    paddingHorizontal: 12,
    gap: 4,
    backgroundColor: colors.card,
    borderRightWidth: 1,
    borderRightColor: colors.separator,
  },
  brand: { paddingHorizontal: 12, paddingBottom: 20, fontSize: 20, fontWeight: '800', color: colors.navy },
  sideItem: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  sideItemSelected: { backgroundColor: colors.navyTint },
  bottomBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    backgroundColor: colors.card,
  },
  bottomItem: { flex: 1, height: 56, alignItems: 'center', justifyContent: 'center', gap: 2 },
  itemLabel: { fontSize: 15, fontWeight: '500', color: colors.textSecondary },
  itemLabelSelected: { color: colors.navy, fontWeight: '700' },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.navy,
  },
  badgeFloat: { position: 'absolute', top: 4, left: '50%', marginLeft: 6, minWidth: 18, height: 18 },
  badgeText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
});
