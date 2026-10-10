// REQ-013 / REQ-095: continuous dragging and recovery after background interruption.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { cancelAnimation, runOnUI, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const spring = { damping: 30, stiffness: 280, mass: 1, overshootClamping: true };

export function SwipeSidebar({ children, sidebar, open, width, gesturesEnabled, onOpenChange, onEdgeBack }: {
  children: ReactNode;
  sidebar: ReactNode;
  open: boolean;
  width: number;
  gesturesEnabled: boolean;
  onOpenChange: (open: boolean) => void;
  onEdgeBack: () => void;
}) {
  const offset = useSharedValue(open ? width : 0);
  const startOffset = useSharedValue(0);
  const startX = useSharedValue(0);
  const ended = useSharedValue(false);
  const dragging = useSharedValue(false);
  const confirmed = useRef({ open, width });
  const target = useRef({ open, width });
  useLayoutEffect(() => { confirmed.current = { open, width }; }, [open, width]);
  const active = useSharedValue(AppState.currentState === 'active');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [visible, setVisible] = useState(open);

  function hideSidebar() { if (!confirmed.current.open) setVisible(false); }
  function beginDrag() { if (AppState.currentState !== 'active') return; setVisible(true); Keyboard.dismiss(); }
  function commitOpen(nextOpen: boolean) {
    if (AppState.currentState !== 'active') return;
    target.current = { open: nextOpen, width: confirmed.current.width };
    onOpenChange(nextOpen);
  }

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const nextForeground = state === 'active';
      setForeground(nextForeground);
      const { open: confirmedOpen, width: confirmedWidth } = confirmed.current;
      // No synchronous SharedValue reads on RN while the UI runtime is suspended.
      runOnUI(() => {
        'worklet';
        active.set(nextForeground);
        cancelAnimation(offset);
        ended.set(true);
        dragging.set(false);
        startOffset.set(0);
        startX.set(0);
        offset.set(confirmedOpen ? confirmedWidth : 0);
      })();
      setVisible(confirmedOpen);
    });
    return () => subscription.remove();
  }, [active, dragging, ended, offset, startOffset, startX]);

  useEffect(() => {
    if (target.current.open === open && target.current.width === width) return;
    target.current = { open, width };
    if (open) { scheduleOnRN(beginDrag); }
    offset.set(withSpring(open ? width : 0, spring, (finished) => {
      if (finished && !open) scheduleOnRN(hideSidebar);
    }));
  }, [open, width, offset]);

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onOpenChange(false);
      offset.set(withSpring(0, spring, (finished) => {
        if (finished) scheduleOnRN(hideSidebar);
      }));
      return true;
    });
    return () => subscription.remove();
  }, [visible, onOpenChange, offset]);

  // Gesture callbacks run on interaction, not during render; their RN callbacks
  // consult the latest committed props only when scheduled by the UI runtime.
  /* eslint-disable react-hooks/refs */
  const pan = Gesture.Pan()
    .enabled(gesturesEnabled && foreground)
    .activeOffsetX(open || visible ? [-10, 10] : 10)
    .failOffsetY([-12, 12])
    .onBegin((event) => { startX.set(event.absoluteX); ended.set(false); dragging.set(false); })
    .onStart(() => {
      if (!active.value) return;
      dragging.set(true);
      cancelAnimation(offset);
      startOffset.set(offset.value);
      if (startX.value > 32 || startOffset.value > 0) scheduleOnRN(beginDrag);
    })
    .onUpdate((event) => {
      if (!active.value) return;
      if (startX.value <= 32 && startOffset.value === 0) return;
      offset.set(Math.max(0, Math.min(width, startOffset.value + event.translationX)));
    })
    .onEnd((event) => {
      if (!active.value) return;
      ended.set(true);
      if (startX.value <= 32 && startOffset.value === 0) {
        if (event.translationX >= 64) scheduleOnRN(onEdgeBack);
        return;
      }
      const nextOpen = Math.abs(event.velocityX) > 500
        ? event.velocityX > 0
        : offset.value + event.velocityX * 0.15 > width / 2;
      offset.set(withSpring(nextOpen ? width : 0, { ...spring, velocity: event.velocityX }, (finished) => {
        if (finished && !nextOpen) scheduleOnRN(hideSidebar);
      }));
      scheduleOnRN(commitOpen, nextOpen);
    })
    .onFinalize(() => {
      if (!active.value || ended.value || !dragging.value) return;
      offset.set(withSpring(open ? width : 0, spring, (finished) => {
        if (finished && !open) scheduleOnRN(hideSidebar);
      }));
    });
  /* eslint-enable react-hooks/refs */
  const sidebarStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value - width }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: offset.value / width }));

  function closeSidebar() {
    onOpenChange(false);
    offset.set(withSpring(0, spring, (finished) => {
      if (finished) scheduleOnRN(hideSidebar);
    }));
  }

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.screen}>
        {children}
        <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}>
          <Reanimated.View style={[StyleSheet.absoluteFill, styles.scrim, backdropStyle]}>
            <Pressable accessibilityLabel="关闭筛选侧栏" accessibilityRole="button" onPress={closeSidebar} style={styles.screen} />
          </Reanimated.View>
          <Reanimated.View style={[styles.sidebar, { width }, sidebarStyle]}>{sidebar}</Reanimated.View>
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrim: { backgroundColor: 'rgba(18, 20, 17, 0.36)' },
  sidebar: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});
