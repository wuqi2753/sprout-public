// REQ-054: measure a non-painted text prefix rather than fixing suggestions to the toolbar.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { positionTagSuggestions } from '@/components/tag-suggestion-position';

type InputFrame = { x: number; y: number; width: number; viewportWidth: number; viewportHeight: number };

export function CaretTagSuggestions({ content, cursor, tags, onSelect, inputRef, viewportRef, layoutKey, textStyle, padding = 0, toolbarInset = 0 }: {
  content: string; cursor: number; tags: string[]; onSelect: (tag: string) => void;
  inputRef: RefObject<TextInput | null>; viewportRef: RefObject<View | null>;
  layoutKey: string; textStyle: TextStyle; padding?: number; toolbarInset?: number;
}) {
  const theme = useTheme();
  const [frame, setFrame] = useState<InputFrame>();
  const [caretLine, setCaretLine] = useState<{ prefix: string; x: number; top: number; bottom: number }>();
  const measurementRef = useRef<Text>(null);
  const markerRef = useRef<Text>(null);
  const prefix = `${content.slice(0, cursor)}\u200b`;
  useEffect(() => {
    let active = true;
    const animationFrame = requestAnimationFrame(() => {
      inputRef.current?.measureInWindow((inputX, inputY, inputWidth) => {
        viewportRef.current?.measureInWindow((viewportX, viewportY, viewportWidth, viewportHeight) => {
          if (!active) return;
          const next = { x: inputX - viewportX, y: inputY - viewportY, width: inputWidth - padding * 2,
            viewportWidth, viewportHeight: viewportHeight - toolbarInset };
          setFrame((previous) => previous && Object.keys(next).every((key) => previous[key as keyof InputFrame] === next[key as keyof InputFrame]) ? previous : next);
        });
      });
    });
    return () => { active = false; cancelAnimationFrame(animationFrame); };
  }, [prefix, layoutKey, inputRef, viewportRef, padding, toolbarInset]);

  const position = frame && caretLine?.prefix === prefix ? positionTagSuggestions({
    caretX: frame.x + padding + caretLine.x, lineTop: frame.y + padding + caretLine.top,
    lineBottom: frame.y + padding + caretLine.bottom, width: frame.viewportWidth, height: frame.viewportHeight, count: tags.length,
  }) : undefined;

  return <>
    {frame && frame.width > 0 && <Text ref={measurementRef} key={`${prefix}:${frame.width}`} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      pointerEvents="none" style={[textStyle, styles.measurement, { width: frame.width }]}
      onLayout={() => {
        if (Platform.OS !== 'web') return;
        markerRef.current?.measureInWindow((x, y, _width, height) => {
          measurementRef.current?.measureInWindow((originX, originY) => {
            setCaretLine({ prefix, x: x - originX, top: y - originY, bottom: y - originY + height });
          });
        });
      }}
      onTextLayout={(event) => {
        const last = event.nativeEvent.lines.at(-1);
        if (last) setCaretLine({ prefix, x: last.x + last.width, top: last.y, bottom: last.y + last.height });
      }}>{content.slice(0, cursor)}<Text ref={markerRef}>{'\u200b'}</Text></Text>}
    {position && <ScrollView keyboardShouldPersistTaps="always" style={[styles.popup, position, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {tags.map((tag) => <Pressable key={tag} accessibilityRole="button" accessibilityLabel={`选择标签 ${tag}`}
        onPress={() => onSelect(tag)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.backgroundSelected }]}>
        <ThemedText numberOfLines={1} style={styles.label}># {tag}</ThemedText>
      </Pressable>)}
    </ScrollView>}
  </>;
}

const styles = StyleSheet.create({
  measurement: { position: 'absolute', top: 0, left: 0, opacity: 0, padding: 0 },
  popup: { position: 'absolute', zIndex: 20, elevation: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  row: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12 },
  label: { fontSize: 15, lineHeight: 22 },
});
