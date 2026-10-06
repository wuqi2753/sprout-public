// REQ-010: docs/stories/v0.2.0/REQ-010-calibrate-flomo-layout-details.md
import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

export const CAPTURE_ENTRY_BOTTOM_GAP = 20;
const CAPTURE_FADE_STOPS = [
  { offset: 0, opacity: 0 },
  { offset: 0.25, opacity: 0.55 },
  { offset: 0.55, opacity: 0.94 },
  { offset: 0.75, opacity: 1 },
  { offset: 1, opacity: 1 },
] as const;

export function CaptureBackdropFade({ color, entryHeight }: { color: string; entryHeight: number }) {
  const insets = useSafeAreaInsets();
  const fadeHeight = entryHeight / 2;
  const bottomFillHeight = insets.bottom + CAPTURE_ENTRY_BOTTOM_GAP;
  const overlayHeight = fadeHeight + bottomFillHeight;
  const gradientId = `capture-fade-${useId().replace(/:/g, '')}`;

  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" style={[styles.fade, { top: entryHeight / 2, height: overlayHeight }]}>
      <Svg width="100%" height={overlayHeight}>
        <Defs>
          <LinearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            {CAPTURE_FADE_STOPS.map(({ offset, opacity }) => (
              <Stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={fadeHeight} fill={`url(#${gradientId})`} />
        <Rect y={fadeHeight} width="100%" height={bottomFillHeight} fill={color} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', left: 0, right: 0 },
});
