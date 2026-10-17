import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { colors } from '../theme';
import { ChevronLeft } from './icons';

// デザインは幅 390 で描いているので、画面幅に合わせて拡大する
const DESIGN_WIDTH = 390;

// 右上の丸い形と、下の2層の波
export function BackgroundShapes() {
  const { width } = useWindowDimensions();
  const scale = width / DESIGN_WIDTH;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={280 * scale} viewBox="0 0 390 280" style={styles.top}>
        <Path
          d="M232 -36C312 -52 410 -6 420 82C428 156 380 214 314 222C256 229 214 196 196 146C176 92 170 -24 232 -36Z"
          fill={colors.shapeBlob}
        />
        <Path
          d="M300 168C336 150 382 160 400 196C414 226 398 262 364 270C334 277 304 262 292 236C280 210 278 180 300 168Z"
          fill={colors.shapeBlobSmall}
        />
      </Svg>
      <Svg width={width} height={224 * scale} viewBox="0 620 390 224" style={styles.bottom}>
        <Path d="M-40 668C30 626 104 650 168 694C236 740 318 744 420 700V880H-40Z" fill={colors.shapeWave} />
        <Path d="M-40 758C42 722 120 760 196 792C268 822 344 812 420 780V880H-40Z" fill={colors.shapeWaveDeep} />
      </Svg>
    </View>
  );
}

// 画面の地。背景のシェイプを敷き、上の安全領域だけ空ける
export function Screen({ children, safeTop = true }: { children: ReactNode; safeTop?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, safeTop && { paddingTop: insets.top }]}>
      <BackgroundShapes />
      {children}
    </View>
  );
}

type NavBarProps = {
  title?: string;
  backLabel?: string;
  onBack?: () => void;
  right?: ReactNode;
};

// 戻るボタン、中央のタイトル、右のボタンを並べる高さ 44 のバー
export function NavBar({ title, backLabel, onBack, right }: NavBarProps) {
  return (
    <View style={styles.navBar}>
      {title ? (
        <View pointerEvents="none" style={styles.navTitleBox}>
          <Text numberOfLines={1} style={styles.navTitle} accessibilityRole="header">
            {title}
          </Text>
        </View>
      ) : null}
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={backLabel ? `${backLabel}に戻る` : '戻る'}
          hitSlop={4}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <ChevronLeft />
          {backLabel ? <Text style={styles.backLabel}>{backLabel}</Text> : null}
        </Pressable>
      ) : null}
      <View style={styles.navRight}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  top: { position: 'absolute', top: 0, left: 0 },
  bottom: { position: 'absolute', bottom: 0, left: 0 },
  navBar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  navTitleBox: {
    ...StyleSheet.absoluteFill,
    paddingHorizontal: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    paddingRight: 8,
  },
  backLabel: {
    fontSize: 17,
    color: colors.navy,
  },
  navRight: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
  },
  pressed: { opacity: 0.5 },
});
