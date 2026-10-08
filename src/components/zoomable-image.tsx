// REQ-071: docs/stories/v0.2.0/REQ-071-pinch-image-preview.md
import { Image } from 'expo-image';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { clampImageOffset, clampImageScale } from './image-zoom';

export function ZoomableImage({ uri, width, height, pagingGesture, onZoomChange }: {
  uri: string;
  width: number;
  height: number;
  pagingGesture: ReturnType<typeof Gesture.Native>;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const scale = useSharedValue(1);
  const startingScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startingX = useSharedValue(0);
  const startingY = useSharedValue(0);
  const imageWidth = useSharedValue(width);
  const imageHeight = useSharedValue(height);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const pinchX = useSharedValue(0);
  const pinchY = useSharedValue(0);

  const gestures = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onTouchesDown((event) => {
        if (event.numberOfTouches === 2) scheduleOnRN(onZoomChange, true);
      })
      .simultaneousWithExternalGesture(pagingGesture)
      .onStart((event) => {
        startingScale.set(scale.get());
        pinchX.set(x.get());
        pinchY.set(y.get());
        focalX.set(event.focalX - width / 2);
        focalY.set(event.focalY - height / 2);
      })
      .onUpdate((event) => {
        if (event.numberOfPointers !== 2) return;
        const nextScale = clampImageScale(startingScale.get() * event.scale);
        const ratio = nextScale / startingScale.get();
        x.set(clampImageOffset(event.focalX - width / 2 - (focalX.get() - pinchX.get()) * ratio, imageWidth.get(), width, nextScale));
        y.set(clampImageOffset(event.focalY - height / 2 - (focalY.get() - pinchY.get()) * ratio, imageHeight.get(), height, nextScale));
        scale.set(nextScale);
      })
      .onFinalize(() => { scheduleOnRN(onZoomChange, scale.get() > 1); });

    const pan = Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .blocksExternalGesture(pagingGesture)
      .onTouchesMove((event, state) => {
        if (event.numberOfTouches === 1 && scale.get() > 1) state.activate();
        else state.fail();
      })
      .onStart(() => { startingX.set(x.get()); startingY.set(y.get()); })
      .onUpdate((event) => {
        x.set(clampImageOffset(startingX.get() + event.translationX, imageWidth.get(), width, scale.get()));
        y.set(clampImageOffset(startingY.get() + event.translationY, imageHeight.get(), height, scale.get()));
      });
    return Gesture.Simultaneous(pinch, pan);
  }, [pagingGesture, startingScale, scale, pinchX, pinchY, x, y, focalX, focalY, width, height, imageWidth, imageHeight, onZoomChange, startingX, startingY]);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  return <GestureDetector gesture={gestures}>
    <View collapsable={false} style={{ width, height, overflow: 'hidden' }}>
      <Animated.View renderToHardwareTextureAndroid style={[StyleSheet.absoluteFill, imageStyle]}>
        <Image source={{ uri }} contentFit="contain" style={StyleSheet.absoluteFill} onLoad={(event) => {
          const ratio = Math.min(width / event.source.width, height / event.source.height);
          imageWidth.set(event.source.width * ratio);
          imageHeight.set(event.source.height * ratio);
        }} />
      </Animated.View>
    </View>
  </GestureDetector>;
}
