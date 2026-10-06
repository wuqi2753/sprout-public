// REQ-061: flomo-inspired typography; no network or persistence inside routes.
import { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { rememberRecordingStart } from '@/storage/recording-start';
import { calculateMemoStatistics } from '@/storage/memo-statistics-rules';
import type { Memo } from '@/types/memo';

export function MemoStatistics({ memos, visible }: { memos: Memo[]; visible: boolean }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const [statistics, setStatistics] = useState<ReturnType<typeof calculateMemoStatistics> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    async function refreshStatistics() {
      try {
        const start = await rememberRecordingStart(memos.map((memo) => memo.createdOn));
        const next = calculateMemoStatistics(memos, start);
        if (active) { setStatistics(next); setError(null); }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : '无法读取记录统计。');
      }
    }
    void refreshStatistics();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshStatistics();
    });
    return () => { active = false; subscription.remove(); };
  }, [memos, visible]);
  if (error) return <ThemedText accessibilityRole="alert" style={styles.error} themeColor="danger">{error}</ThemedText>;
  const entries = [['笔记', statistics?.memoCount], ['标签', statistics?.tagCount], ['天', statistics?.recordingDays]] as const;
  return (
    <View style={styles.row}>
      {entries.map(([label, count]) => (
        <View key={label} style={[styles.column, { minWidth: Math.max(52, String(count ?? '…').length * 17 * fontScale, label.length * 14 * fontScale) }]} accessible accessibilityLabel={`${count ?? '加载中'} ${label}`}>
          <ThemedText style={[styles.number, { color: theme.memoStatisticsText }]}>{count ?? '…'}</ThemedText>
          <ThemedText style={[styles.label, { color: theme.memoStatisticsText }]}>{label}</ThemedText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingLeft: 30, paddingRight: 16, paddingTop: 24, paddingBottom: 4 },
  column: { flexGrow: 1, flexBasis: 0, maxWidth: '100%' },
  number: { fontFamily: Platform.OS === 'android' ? 'sans-serif-condensed' : undefined, fontSize: 28, lineHeight: 34, fontWeight: '700', marginBottom: 2 },
  label: { fontSize: 14, lineHeight: 17, fontWeight: '400' },
  error: { padding: 16, fontSize: 14 },
});
