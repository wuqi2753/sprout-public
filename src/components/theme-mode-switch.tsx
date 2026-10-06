// REQ-046: Compact sun/moon switch modeled on tweakcn's editor toggle.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { Pressable } from '@/components/haptic-pressable';
import { useAppTheme } from '@/components/app-theme-provider';
import { useTheme } from '@/hooks/use-theme';

export function ThemeModeSwitch() {
  const appTheme = useAppTheme();
  const theme = useTheme();
  const dark = appTheme?.colorScheme === 'dark';
  const position = useSharedValue(dark ? 20 : 0);
  useEffect(() => {
    position.value = withTiming(dark ? 20 : 0, { duration: appTheme?.reducedMotion ? 0 : 200, easing: Easing.inOut(Easing.quad) });
  }, [dark, position, appTheme?.reducedMotion]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: position.value }] }));
  if (!appTheme) return null;
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel="深色模式"
      accessibilityState={{ checked: dark, disabled: !appTheme.ready || appTheme.changing }}
      disabled={!appTheme.ready || appTheme.changing}
      onPress={({ nativeEvent }) => { void appTheme.selectTheme(dark ? 'light' : 'dark', { x: nativeEvent.pageX, y: nativeEvent.pageY }); }}
      style={({ pressed }) => [styles.touchTarget, pressed && { opacity: 0.75 }]}>
      <View style={[styles.track, { backgroundColor: dark ? theme.text : theme.backgroundSelected }]}>
        <Animated.View style={[styles.thumb, { backgroundColor: theme.background }, thumbStyle]}>
          <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={theme.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            {dark ? <Path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" /> : <>
              <Circle cx={12} cy={12} r={4} />
              <Path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
            </>}
          </Svg>
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touchTarget: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  track: { width: 44, height: 24, padding: 2, borderRadius: 12 },
  thumb: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
