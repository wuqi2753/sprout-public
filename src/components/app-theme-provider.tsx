// REQ-046: A circular reveal from the switch follows tweakcn's theme transition.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Image, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, Image as SvgImage, Mask, Rect } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';

import { FeedbackDialog } from '@/components/feedback-dialog';
import { Colors } from '@/constants/theme';
import { hiddenMemoSession } from '@/auth/hidden-memo-session';
import { getThemePreference, saveThemePreference, type ThemePreference } from '@/storage/theme-preference';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
type ThemeOrigin = { x: number; y: number };
const waitForPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const AppThemeContext = createContext<{
  colorScheme: ThemePreference;
  changing: boolean;
  ready: boolean;
  reducedMotion: boolean;
  selectTheme: (preference: ThemePreference, origin?: ThemeOrigin) => Promise<void>;
} | undefined>(undefined);

export function useAppTheme() {
  return useContext(AppThemeContext);
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>();
  const colorScheme = preference ?? 'dark';
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const rootRef = useRef<View>(null);
  const transitionGeneration = useRef(0);
  const snapshotLoaded = useRef<(() => void) | undefined>(undefined);
  const webTransition = useRef<ViewTransition | undefined>(undefined);
  const windowSize = useWindowDimensions();
  const [size, setSize] = useState({ width: windowSize.width, height: windowSize.height });
  const [snapshot, setSnapshot] = useState<{ uri: string; origin: ThemeOrigin }>();
  const radius = useSharedValue(0);
  const circleProps = useAnimatedProps(() => ({ r: radius.get() }));

  const [themeError, setThemeError] = useState<string>();
  function showThemeError(message: string) { setThemeError(message); }

  useEffect(() => {
    let active = true;
    getThemePreference().then((saved) => {
      if (active) setPreference(saved);
    }).catch(() => {
      if (active) showThemeError('无法读取显示模式，将使用深色模式。');
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const invalidateTransition = () => {
      transitionGeneration.current++;
      cancelAnimation(radius);
      snapshotLoaded.current?.();
      webTransition.current?.skipTransition();
    };
    const unsubscribe = hiddenMemoSession.subscribe(() => {
      if (!hiddenMemoSession.getSnapshot().unlocked) {
        invalidateTransition();
        setSnapshot(undefined);
      }
    });
    return () => { unsubscribe(); invalidateTransition(); };
  }, [radius]);

  async function selectTheme(nextPreference: ThemePreference, tappedOrigin?: ThemeOrigin) {
    if (!ready || changingRef.current) return;
    changingRef.current = true;
    setChanging(true);
    const generation = ++transitionGeneration.current;
    const stillActive = () => transitionGeneration.current === generation;
    let saved = false;
    let stage: 'prepare' | 'capture' | 'load' | 'save' | 'animate' = 'prepare';
    try {
      const reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
      setReducedMotion(reduceMotion);
      const origin = tappedOrigin ?? { x: size.width / 2, y: size.height / 2 };
      if (nextPreference === colorScheme || reduceMotion) {
        stage = 'save';
        await saveThemePreference(nextPreference);
        if (stillActive()) setPreference(nextPreference);
        return;
      }
      if (Platform.OS === 'web') {
        stage = 'save';
        await saveThemePreference(nextPreference);
        saved = true;
        if (!stillActive()) return;
        document.documentElement.style.setProperty('--theme-x', `${origin.x}px`);
        document.documentElement.style.setProperty('--theme-y', `${origin.y}px`);
        if (document.startViewTransition) {
          const transition = document.startViewTransition(async () => { setPreference(nextPreference); await waitForPaint(); });
          webTransition.current = transition;
          await transition.finished;
        } else {
          setPreference(nextPreference);
          await document.documentElement.animate([{ opacity: 0.7 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' }).finished;
        }
        return;
      }
      // Keep the old view only in memory; no screenshot file is written.
      stage = 'capture';
      const uri = await captureRef(rootRef, {
        width: Math.round(size.width), height: Math.round(size.height),
        format: 'jpg', quality: 0.9, result: 'data-uri',
      });
      if (!stillActive()) return;
      const rootOffset = await new Promise<ThemeOrigin>((resolve) => {
        if (!rootRef.current) throw new Error('Theme transition root is unavailable');
        rootRef.current.measureInWindow((x, y) => resolve({ x, y }));
      });
      const localOrigin = { x: Math.max(0, Math.min(size.width, origin.x - rootOffset.x)), y: Math.max(0, Math.min(size.height, origin.y - rootOffset.y)) };
      radius.set(0);
      stage = 'load';
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          snapshotLoaded.current = undefined;
          reject(new Error('Theme snapshot did not load'));
        }, 2000);
        snapshotLoaded.current = () => { clearTimeout(timeout); snapshotLoaded.current = undefined; resolve(); };
        setSnapshot({ uri, origin: localOrigin });
      });
      if (!stillActive()) return;
      stage = 'save';
      await saveThemePreference(nextPreference);
      saved = true;
      if (!stillActive()) return;
      setPreference(nextPreference);
      await waitForPaint();
      if (!stillActive()) return;
      const maximumRadius = Math.hypot(Math.max(localOrigin.x, size.width - localOrigin.x), Math.max(localOrigin.y, size.height - localOrigin.y)) + 1;
      stage = 'animate';
      await new Promise<void>((resolve) => {
        radius.set(withTiming(maximumRadius, { duration: 400, easing: Easing.inOut(Easing.quad) }, () => { runOnJS(resolve)(); }));
      });
    } catch {
      console.error(`Theme switch failed at ${stage}`);
      const message = stage === 'capture' ? '无法生成切换动画，请重新打开 App 后重试。'
        : stage === 'load' ? '切换动画加载失败，请重试。'
        : stage === 'save' ? '无法保存显示模式，请重试。'
        : '无法切换显示模式，请重试。';
      showThemeError(saved ? '显示模式已保存，但切换动画未完成。' : message);
    } finally {
      webTransition.current = undefined;
      setSnapshot(undefined);
      changingRef.current = false;
      setChanging(false);
    }
  }

  return (
    <AppThemeContext.Provider value={{ colorScheme, changing, ready, reducedMotion, selectTheme }}>
      <View ref={rootRef} collapsable={false} onLayout={({ nativeEvent }) => setSize({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}
        style={{ flex: 1, backgroundColor: Colors[colorScheme].background }}>
        {children}
        {snapshot && (
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
            {/* SVG's Android cache-hit path does not emit onLoad; RN Image does. */}
            <Image source={{ uri: snapshot.uri }} onLoad={() => snapshotLoaded.current?.()}
              style={[StyleSheet.absoluteFill, { opacity: 0 }]} />
            <Svg width={size.width} height={size.height}>
              <Defs><Mask id="old-theme" x="0" y="0" width={size.width} height={size.height} maskUnits="userSpaceOnUse">
                <Rect width={size.width} height={size.height} fill="white" />
                <AnimatedCircle cx={snapshot.origin.x} cy={snapshot.origin.y} animatedProps={circleProps} fill="black" />
              </Mask></Defs>
              <SvgImage href={{ uri: snapshot.uri }} onLoad={() => snapshotLoaded.current?.()} width={size.width} height={size.height} preserveAspectRatio="none" mask="url(#old-theme)" />
            </Svg>
          </View>
        )}
        {changing && <View style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
        <FeedbackDialog visible={themeError !== undefined} title="无法设置显示模式" message={themeError} onDismiss={() => setThemeError(undefined)} />
      </View>
    </AppThemeContext.Provider>
  );
}
