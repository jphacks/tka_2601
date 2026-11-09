import { type ReactNode, useEffect, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import type { SymbolName } from '../lib/symbols';
import { colors } from '../theme';
import { Icon } from './Icon';
import { Screen } from './Screen';

// 本体とチャイムの登録の画面の共通の形。上に丸い札と見出し、下にボタンを置く
type Badge =
  // 白い丸だけ
  | { kind: 'plain' }
  // 白い丸のまわりを回る輪（待っているあいだ）。dash は輪の弧の長さ（周 289）、start は弧の始まりの角度
  | { kind: 'ring'; label: string; dash: number; start: number }
  // 白い丸の外に広がる2重の円（音を待っているあいだ）
  | { kind: 'halo'; label: string }
  // 紺で塗った丸に白い印（完了）
  | { kind: 'filled' };

export function OnboardingLayout({
  icon,
  badge,
  title,
  message,
  step,
  children,
}: {
  icon: SymbolName;
  badge: Badge;
  title: string;
  // 失敗の理由の1行
  message?: string | null;
  // 3つの点のうち、いまの段階
  step?: 1 | 2 | 3 | null;
  // 下のボタン。なければ、同じ高さの空きを残す
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const filled = badge.kind === 'filled';
  return (
    <Screen safeTop={false}>
      {step ? (
        <View accessible accessibilityRole="image" accessibilityLabel={`3 ステップのうち ${step}`} style={styles.dots}>
          {[1, 2, 3].map((n) => (
            <View key={n} style={[styles.dot, n === step && styles.dotActive]} />
          ))}
        </View>
      ) : null}
      <View style={[styles.content, { paddingBottom: insets.bottom + 116 }]}>
        <View style={styles.top}>
          <View
            style={styles.badge}
            accessibilityRole={badge.kind === 'ring' || badge.kind === 'halo' ? 'progressbar' : undefined}
            accessibilityLabel={badge.kind === 'ring' || badge.kind === 'halo' ? badge.label : undefined}
          >
            {badge.kind === 'halo' ? <Halo /> : null}
            <View style={[styles.circle, filled && styles.circleFilled]}>
              <Icon name={icon} size={filled || badge.kind === 'plain' ? 44 : 40} color={filled ? '#FFFFFF' : colors.navy} />
            </View>
            {badge.kind === 'ring' ? <Ring dash={badge.dash} start={badge.start} /> : null}
          </View>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {message ? (
            <Text style={styles.message} accessibilityRole="alert">
              {message}
            </Text>
          ) : null}
        </View>
        {children ? <View style={styles.actions}>{children}</View> : <View style={styles.spacer} />}
      </View>
    </Screen>
  );
}

function Halo() {
  return (
    <Svg width={168} height={168} viewBox="0 0 168 168" style={styles.halo}>
      <Circle cx={84} cy={84} r={82} fill={colors.navyTint} fillOpacity={0.8} stroke={colors.navy} strokeOpacity={0.18} strokeWidth={2} />
      <Circle cx={84} cy={84} r={62} fill={colors.shapeBlob} stroke={colors.navy} strokeOpacity={0.35} strokeWidth={2} />
    </Svg>
  );
}

// 弧は回し続ける。止まって見えると、待っているのか固まったのか分からない
function Ring({ dash, start }: { dash: number; start: number }) {
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View pointerEvents="none" style={[styles.ring, { transform: [{ rotate }] }]}>
      <Svg width={104} height={104} viewBox="0 0 104 104">
        <Circle cx={52} cy={52} r={46} fill="none" stroke={colors.shapeBlob} strokeWidth={4} />
        <Circle
          cx={52}
          cy={52}
          r={46}
          fill="none"
          stroke={colors.navy}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={`${dash} 289`}
          transform={`rotate(${start} 52 52)`}
        />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dots: {
    position: 'absolute',
    top: 96,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#C3CEDD' },
  dotActive: { width: 24, backgroundColor: colors.navy },
  content: { flex: 1, paddingTop: 140, paddingHorizontal: 24, justifyContent: 'space-between' },
  top: { alignItems: 'center', gap: 16 },
  badge: { width: 88, height: 88, marginBottom: 24 },
  circle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleFilled: { backgroundColor: colors.navy },
  halo: { position: 'absolute', left: -40, top: -40 },
  ring: { position: 'absolute', left: -8, top: -8, width: 104, height: 104 },
  title: { fontSize: 26, fontWeight: '700', lineHeight: 35, textAlign: 'center', color: colors.text },
  message: { fontSize: 17, textAlign: 'center', color: colors.text },
  actions: { gap: 12 },
  spacer: { height: 50 },
});
