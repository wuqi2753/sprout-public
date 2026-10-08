// REQ-069: flomo-style six-column recording time sheet.
import { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { changeMemoTimePart, daysInMemoMonth, memoDateFromParts, memoTimeParts, type MemoTimeParts } from '@/memos/memo-time';
const ROW_HEIGHT = 52;
const UNITS = ['年', '月', '日', '时', '分', '秒'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

function TimeWheel({ values, selected, column, onSelect }: {
  values: number[]; selected: number; column: number; onSelect: (value: number) => void;
}) {
  const theme = useTheme();
  const listRef = useRef<FlatList<number>>(null);
  const lastSelectedRef = useRef(selected);
  const selectedIndex = Math.max(0, values.indexOf(selected));
  useEffect(() => {
    if (lastSelectedRef.current !== selected) {
      listRef.current?.scrollToOffset({ offset: selectedIndex * ROW_HEIGHT, animated: false });
      lastSelectedRef.current = selected;
    }
  }, [selected, selectedIndex]);
  return <FlatList ref={listRef} style={styles.wheel} data={values} keyExtractor={String}
    initialScrollIndex={selectedIndex} getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
    contentContainerStyle={styles.wheelPadding} showsVerticalScrollIndicator={false}
    snapToInterval={ROW_HEIGHT} decelerationRate="fast" scrollEventThrottle={16}
    onScroll={(event) => {
      const index = Math.min(values.length - 1, Math.max(0, Math.round(event.nativeEvent.contentOffset.y / ROW_HEIGHT)));
      const value = values[index];
      if (value !== lastSelectedRef.current) { lastSelectedRef.current = value; onSelect(value); }
    }}
    renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item}${UNITS[column]}`}
      accessibilityState={{ selected: item === selected }} onPress={() => {
        listRef.current?.scrollToOffset({ offset: values.indexOf(item) * ROW_HEIGHT, animated: true });
      }} style={styles.wheelRow}>
      <ThemedText style={[styles.wheelText, { color: item === selected ? theme.text : theme.textSecondary,
        fontWeight: item === selected ? '600' : '400' }]}>
        {column === 0 ? item : String(item).padStart(2, '0')}{item === selected ? UNITS[column] : ''}
      </ThemedText>
    </Pressable>} />;
}
export function MemoTimePicker({ date, onCancel, onConfirm }: { date: Date; onCancel: () => void; onConfirm: (date: Date) => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [parts, setParts] = useState<MemoTimeParts>(() => memoTimeParts(date));
  const [error, setError] = useState('');
  useEffect(() => { Keyboard.dismiss(); }, []);
  const columns = [range(Math.min(1970, date.getFullYear()), Math.max(2100, date.getFullYear())), range(1, 12),
    range(1, daysInMemoMonth(parts[0], parts[1])), range(0, 23), range(0, 59), range(0, 59)];
  const preview = new Date(0);
  preview.setFullYear(parts[0], parts[1] - 1, parts[2]);
  return <Modal transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
    <View style={styles.overlay}>
      <Pressable accessibilityLabel="取消设定日期" onPress={onCancel} style={StyleSheet.absoluteFill} />
      <View style={[styles.sheet, { backgroundColor: theme.background, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <ThemedText style={styles.title}>设定日期</ThemedText>
        <ThemedText style={styles.preview}>{parts[0]}年{String(parts[1]).padStart(2, '0')}月{String(parts[2]).padStart(2, '0')}日 周{WEEKDAYS[preview.getDay()]}</ThemedText>
        <View style={[styles.wheels, { borderColor: theme.border }]}>
          <View pointerEvents="none" style={[styles.selection, { borderColor: theme.border }]} />
          {columns.map((values, column) => <TimeWheel key={column} values={values} selected={parts[column]} column={column}
            onSelect={(value) => { setError(''); setParts((previous) => changeMemoTimePart(previous, column, value)); }} />)}
        </View>
        {Boolean(error) && <ThemedText accessibilityRole="alert" style={styles.error}>{error}</ThemedText>}
        <View style={[styles.actions, { borderColor: theme.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="取消设定日期" onPress={onCancel} style={styles.action}>
            <ThemedText themeColor="textSecondary" style={styles.actionText}>取消</ThemedText>
          </Pressable>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <Pressable accessibilityRole="button" accessibilityLabel="确定记录时间" onPress={() => {
            try { onConfirm(memoDateFromParts(parts)); }
            catch (failure) { setError(failure instanceof Error ? failure.message : '无法设定日期'); }
          }} style={styles.action}><ThemedText style={styles.actionText}>确定</ThemedText></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden' },
  title: { fontSize: 21, fontWeight: '600', textAlign: 'center', paddingTop: 28, paddingBottom: 22 },
  preview: { fontSize: 17, textAlign: 'center', paddingBottom: 22 },
  wheels: { flexDirection: 'row', height: ROW_HEIGHT * 3, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6 },
  wheel: { flex: 1 }, wheelPadding: { paddingVertical: ROW_HEIGHT },
  wheelRow: { height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  wheelText: { fontSize: 16, fontVariant: ['tabular-nums'] },
  selection: { position: 'absolute', top: ROW_HEIGHT, left: 6, right: 6, height: ROW_HEIGHT, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, marginTop: 12 },
  action: { flex: 1, paddingVertical: 20, alignItems: 'center' }, actionText: { fontSize: 19, fontWeight: '500' },
  divider: { width: StyleSheet.hairlineWidth, height: 34 }, error: { textAlign: 'center', padding: 8, fontSize: 13 },
});
