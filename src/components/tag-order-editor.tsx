// REQ-059: flomo-style draft ordering; persistence belongs to storage.
import { useRef, useState } from 'react';
import { Modal, PanResponder, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Pressable } from './haptic-pressable';
import { ThemedText } from './themed-text';
import { useTheme } from '@/hooks/use-theme';
import { moveTag, tagOrderToSave } from '@/storage/tag-order-rules';

function createTagDragResponder(enabled: boolean, begin: () => void, move: (translation: number) => void, end: () => void) {
  return PanResponder.create({
    onStartShouldSetPanResponder: () => enabled,
    onMoveShouldSetPanResponder: () => enabled,
    onPanResponderGrant: begin,
    onPanResponderMove: (_, gesture) => move(gesture.dy),
    onPanResponderRelease: end,
    onPanResponderTerminate: end,
    onPanResponderTerminationRequest: () => false,
  });
}

export function TagOrderEditor({ names, defaultNames, onClose, onSave }: {
  names: string[]; defaultNames: string[]; onClose: () => void; onSave: (names: string[]) => Promise<void>;
}) {
  const theme = useTheme();
  const [draft, setDraft] = useState(names);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [restoringDefault, setRestoringDefault] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowHeight = useRef(56);
  const dragOrigin = useRef(0);
  const dragNames = useRef(draft);
  function beginDrag(name: string, index: number) {
    dragOrigin.current = index; dragNames.current = draft; setDragging(name); setRestoringDefault(false);
  }
  function dragTo(translation: number) {
    const target = Math.max(0, Math.min(dragNames.current.length - 1, dragOrigin.current + Math.round(translation / rowHeight.current)));
    setDraft(moveTag(dragNames.current, dragOrigin.current, target));
  }

  async function save() {
    setSaving(true); setError('');
    try { await onSave(restoringDefault ? [] : tagOrderToSave(draft, defaultNames)); }
    catch { setError('无法保存标签顺序，请重试。'); }
    finally { setSaving(false); }
  }

  return <Modal visible animationType="slide" onRequestClose={() => { if (!saving) onClose(); }}>
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回，放弃未保存排序" accessibilityRole="button" disabled={saving} onPress={onClose} style={styles.button}>
          <Svg width={24} height={24} viewBox="0 0 24 24" accessible={false}><Path d="m15 4-8 8 8 8" fill="none" stroke={theme.textSecondary} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </Pressable>
        <ThemedText style={styles.title}>标签排序</ThemedText>
        <Pressable accessibilityRole="button" disabled={saving || dragging !== null} onPress={() => { void save(); }} style={({ pressed }) => [styles.saveTouchTarget, (pressed || saving) && styles.pressed]}>
          <View style={[styles.save, { backgroundColor: theme.accent }]}><ThemedText style={[styles.saveLabel, { color: theme.onAccent }]}>{saving ? '保存中…' : '保存'}</ThemedText></View>
        </Pressable>
      </View>
      {!!error && <ThemedText accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>{error}</ThemedText>}
      <ScrollView scrollEnabled={!dragging && !saving} contentContainerStyle={styles.list}>
        {!draft.length && <ThemedText themeColor="textSecondary" style={styles.empty}>暂无标签</ThemedText>}
        {/* PanResponder stores callbacks; refs are accessed only on layout and gesture events. */}
        {/* eslint-disable-next-line react-hooks/refs */}
        {draft.map((name, index) => {
          const pan = createTagDragResponder(!saving, () => beginDrag(name, index), dragTo, () => setDragging(null));
          return <View key={name} onLayout={(event) => { rowHeight.current = event.nativeEvent.layout.height; }} style={[styles.row, dragging === name && { backgroundColor: theme.tagDragBackground }]}>
            <View {...pan.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={`调整标签 ${name}，第 ${index + 1} 位`}
              accessibilityActions={[{ name: 'increment', label: '下移' }, { name: 'decrement', label: '上移' }]}
              onAccessibilityAction={(event) => {
                if (saving) return;
                const target = event.nativeEvent.actionName === 'increment' ? index + 1 : index - 1;
                if (target >= 0 && target < draft.length) { setDraft(moveTag(draft, index, target)); setRestoringDefault(false); }
              }} style={styles.button}>
              <Svg width={20} height={20} viewBox="0 0 24 24" accessible={false}><Path d="M5 7h14M5 12h14M5 17h14" stroke={theme.textSecondary} strokeWidth={2} strokeLinecap="round" /></Svg>
            </View>
            <ThemedText style={styles.hash}>#</ThemedText><ThemedText style={styles.name}>{name}</ThemedText>
            {/* Keyboard/button alternative also allows Web users to reorder without dragging. */}
            {Platform.OS === 'web' && <><Pressable accessibilityLabel={`上移标签 ${name}`} accessibilityRole="button" disabled={saving || index === 0} onPress={() => { setDraft(moveTag(draft, index, index - 1)); setRestoringDefault(false); }} style={[styles.button, index === 0 && styles.disabled]}><ThemedText themeColor="textSecondary">↑</ThemedText></Pressable>
            <Pressable accessibilityLabel={`下移标签 ${name}`} accessibilityRole="button" disabled={saving || index === draft.length - 1} onPress={() => { setDraft(moveTag(draft, index, index + 1)); setRestoringDefault(false); }} style={[styles.button, index === draft.length - 1 && styles.disabled]}><ThemedText themeColor="textSecondary">↓</ThemedText></Pressable></>}
          </View>;
        })}
      </ScrollView>
      <Pressable accessibilityRole="button" disabled={saving} onPress={() => { setDraft(defaultNames); setRestoringDefault(true); setError(''); }} style={({ pressed }) => [styles.restore, pressed && styles.pressed]}>
        <ThemedText themeColor="textSecondary">↺ 恢复默认</ThemedText>
      </Pressable>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  screen: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 64, gap: 4 },
  button: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 22, lineHeight: 30, fontWeight: '700' },
  saveTouchTarget: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  save: { minWidth: 44, minHeight: 24, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  saveLabel: { fontSize: 12, lineHeight: 16, fontWeight: '400', includeFontPadding: false },
  list: { paddingHorizontal: 12, paddingBottom: 24 }, row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, borderRadius: 8 },
  hash: { paddingHorizontal: 10, fontSize: 18 }, name: { flex: 1, fontSize: 18, fontWeight: '600', paddingVertical: 12 },
  restore: { minHeight: 56, alignItems: 'center', justifyContent: 'center' }, error: { padding: 16 }, empty: { padding: 24, textAlign: 'center' },
  pressed: { opacity: 0.7 }, disabled: { opacity: 0.3 },
});
