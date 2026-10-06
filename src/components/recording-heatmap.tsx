// REQ-062: seven-row recording footprint, backed by ordinary local memos.
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { recordingDateKey, recordingHeatmap } from './recording-heatmap-rules';
import type { Memo } from '@/types/memo';

type Props = { memos: Memo[]; visible: boolean; selectedDate: Date | null; onSelectDate: (date: Date | null) => void };
export function RecordingHeatmap({ memos, visible, selectedDate, onSelectDate }: Props) {
  const theme = useTheme();
  const [today, setToday] = useState(() => new Date());
  const [width, setWidth] = useState(240);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') setToday(new Date()); });
    return () => subscription.remove();
  }, []);
  // Reopening the sidebar refreshes today's outline without a persistent timer.
  const referenceDate = visible ? new Date() : today;
  const weeks = recordingHeatmap(memos.filter((memo) => !memo.hidden).map((memo) => memo.createdOn), referenceDate);
  const selectedKey = selectedDate ? recordingDateKey(selectedDate) : null;
  const selected = weeks.flat().find((cell) => cell.key === selectedKey);
  const gap = Math.min(6, width / 52);
  const size = Math.max(1, (width - gap * 12) / 13);
  const shades = [theme.backgroundElement, theme.heatmapLevel1, theme.heatmapLevel2, theme.heatmapLevel3, theme.accent];
  const months = weeks.map((week) => week.find((cell) => !cell.future && cell.date.getDate() === 1)?.date.getMonth() ?? week[0].date.getMonth());
  const monthLabels = months.map((month, index) => index === 0 || month !== months[index - 1] ? `${month + 1}月` : '');
  function moveSelectedDate(offset: number) {
    if (!selectedDate) return;
    const next = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + offset);
    if (recordingDateKey(next) >= weeks[0][0].key && recordingDateKey(next) <= recordingDateKey(referenceDate)) onSelectDate(next);
  }
  return (
    <View style={styles.section}>
      <ThemedText style={styles.title} themeColor="textSecondary">记录足迹</ThemedText>
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={[styles.grid, { gap }]}>
        {weeks.map((week) => (
          <View key={week[0].key} style={{ gap, width: size }}>
            {week.map((cell) => (
              <Pressable key={cell.key} disabled={cell.future} accessible={!cell.future}
                accessibilityRole="button" accessibilityLabel={`${cell.key}，${cell.count} 条笔记${cell.today ? '，今天' : ''}`}
                accessibilityState={{ selected: cell.key === selectedKey, disabled: cell.future }}
                onPress={() => onSelectDate(cell.key === selectedKey ? null : cell.date)}
                style={{ width: size, height: size, borderRadius: 3, backgroundColor: cell.future ? 'transparent' : shades[cell.intensity], borderWidth: cell.today || cell.key === selectedKey ? 1.5 : 0, borderColor: cell.key === selectedKey ? theme.text : theme.accent }} />
            ))}
          </View>
        ))}
      </View>
      <View style={styles.months}>
        {monthLabels.map((label, index) => label ? <ThemedText key={index} style={[styles.caption, { marginLeft: index === 0 ? 0 : 4 }]} themeColor="textSecondary">{label}</ThemedText> : null)}
      </View>
      <View style={styles.legend} accessible accessibilityLabel="颜色越深，当天笔记越多：1条、2到3条、4到6条、7条及以上。">
        <ThemedText style={styles.caption} themeColor="textSecondary">少</ThemedText>
        {shades.map((color, index) => <View key={index} style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: color }} />)}
        <ThemedText style={styles.caption} themeColor="textSecondary">多</ThemedText>
      </View>
      {selectedDate && (
        <View>
          <ThemedText style={styles.selection} themeColor="textSecondary">{selectedKey} · {selected?.count ?? 0} 条笔记</ThemedText>
          <View style={styles.controls}>
            <Pressable style={styles.control} accessibilityLabel="查看上一天" onPress={() => moveSelectedDate(-1)}><ThemedText style={styles.controlLabel}>上一天</ThemedText></Pressable>
            <Pressable style={styles.control} accessibilityLabel="查看下一天" disabled={selectedKey === recordingDateKey(referenceDate)} onPress={() => moveSelectedDate(1)}><ThemedText style={[styles.controlLabel, selectedKey === recordingDateKey(referenceDate) && { opacity: 0.4 }]}>下一天</ThemedText></Pressable>
            <Pressable style={styles.control} accessibilityLabel="清除日期筛选" onPress={() => onSelectDate(null)}><ThemedText style={styles.controlLabel}>清除</ThemedText></Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { paddingHorizontal: 30, paddingTop: 20, paddingBottom: 12 },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '400', marginBottom: 12 },
  grid: { flexDirection: 'row' },
  months: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  caption: { fontSize: 11, lineHeight: 16, fontWeight: '400' },
  legend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 6 },
  selection: { fontSize: 12, lineHeight: 18, fontWeight: '400', marginTop: 12 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  control: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 4 },
  controlLabel: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
});
