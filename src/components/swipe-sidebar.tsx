// REQ-013: continuous sidebar dragging and velocity-aware settling.
import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
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
  const targetOpen = useSharedValue(open);
  const targetWidth = useSharedValue(width);
  const [visible, setVisible] = useState(open);

  function hideSidebar() { setVisible(false); }
  function beginDrag() { setVisible(true); Keyboard.dismiss(); }
  function commitOpen(nextOpen: boolean) { onOpenChange(nextOpen); }

  useEffect(() => {
    if (targetOpen.get() === open && targetWidth.get() === width) return;
    targetOpen.set(open);
    targetWidth.set(width);
    if (open) { scheduleOnRN(beginDrag); }
    offset.set(withSpring(open ? width : 0, spring, (finished) => {
      if (finished && !open) scheduleOnRN(hideSidebar);
    }));
  }, [open, width, offset, targetOpen, targetWidth]);

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

  const pan = Gesture.Pan()
    .enabled(gesturesEnabled)
    .activeOffsetX(open || visible ? [-10, 10] : 10)
    .failOffsetY([-12, 12])
    .onBegin((event) => { startX.value = event.absoluteX; ended.value = false; dragging.value = false; })
    .onStart(() => {
      dragging.value = true;
      cancelAnimation(offset);
      startOffset.value = offset.value;
      if (startX.value > 32 || startOffset.value > 0) scheduleOnRN(beginDrag);
    })
    .onUpdate((event) => {
      if (startX.value <= 32 && startOffset.value === 0) return;
      offset.set(Math.max(0, Math.min(width, startOffset.value + event.translationX)));
    })
    .onEnd((event) => {
      ended.value = true;
      if (startX.value <= 32 && startOffset.value === 0) {
        if (event.translationX >= 64) scheduleOnRN(onEdgeBack);
        return;
      }
      const nextOpen = Math.abs(event.velocityX) > 500
        ? event.velocityX > 0
        : offset.value + event.velocityX * 0.15 > width / 2;
      targetOpen.set(nextOpen);
      offset.set(withSpring(nextOpen ? width : 0, { ...spring, velocity: event.velocityX }, (finished) => {
        if (finished && !nextOpen) scheduleOnRN(hideSidebar);
      }));
      scheduleOnRN(commitOpen, nextOpen);
    })
    .onFinalize(() => {
      if (ended.value || !dragging.value) return;
      offset.set(withSpring(open ? width : 0, spring, (finished) => {
        if (finished && !open) scheduleOnRN(hideSidebar);
      }));
    });
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
