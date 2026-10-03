import { SymbolView } from 'expo-symbols';
import { type DimensionValue, ScrollView, StyleSheet, View } from 'react-native';

import { Pressable } from '@/components/haptic-pressable';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type TagCount = {
  name: string;
  count: number;
};

export type ServerConnectionStatus = 'unconfigured' | 'connecting' | 'connected' | 'failed';

type ExploreFilterPanelProps = {
  activeDay: number | null;
  activeTag: string | null;
  connectionStatus: ServerConnectionStatus;
  month: number;
  recordDays: Set<number>;
  tags: TagCount[];
  year: number;
  onAddServer: () => void;
  onChangeMonth: (offset: number) => void;
  onSelectDay: (day: number) => void;
  onSelectTag: (tag: string) => void;
  width?: DimensionValue;
};

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];

function getCalendarCells(year: number, month: number) {
  const leadingEmptyCells = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return [
    ...Array.from({ length: leadingEmptyCells }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
}

export function ExploreFilterPanel({
  activeDay,
  activeTag,
  connectionStatus,
  month,
  recordDays,
  tags,
  year,
  onAddServer,
  onChangeMonth,
  onSelectDay,
  onSelectTag,
  width = 292,
}: ExploreFilterPanelProps) {
  const theme = useTheme();
  const calendarCells = getCalendarCells(year, month);
  const connectionStatusPresentation = {
    unconfigured: { color: theme.textSecondary, label: '未配置服务器' },
    connecting: { color: '#D99A22', label: '连接中...' },
    connected: { color: '#3B9B5F', label: '已连接' },
    failed: { color: theme.danger, label: '连接失败' },
  }[connectionStatus];

  return (
    <View style={[styles.panel, { width, backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={[styles.panelHeader, { borderBottomColor: theme.border }]}>
        <View
          accessibilityLabel={`Server ${connectionStatusPresentation.label}`}
          accessibilityLiveRegion="polite"
          accessible
          style={styles.connectionStatus}>
          <View
            style={[styles.connectionStatusDot, { backgroundColor: connectionStatusPresentation.color }]}
          />
          <ThemedText style={styles.connectionStatusLabel}>{connectionStatusPresentation.label}</ThemedText>
        </View>
        <Pressable
          accessibilityLabel="服务器设置"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onAddServer}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          <View
            style={[
              styles.serverSettingsIconFrame,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <SymbolView
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              size={18}
              tintColor={theme.textSecondary}
            />
          </View>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.calendarSection}>
          <View style={styles.monthHeader}>
            <ThemedText style={styles.monthTitle}>
              {year} 年 {month + 1} 月
            </ThemedText>
            <View style={styles.monthControls}>
              <Pressable
                accessibilityLabel="上个月"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => onChangeMonth(-1)}
                style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}>
                <SymbolView
                  name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }}
                  size={18}
                  tintColor={theme.textSecondary}
                />
              </Pressable>
              <Pressable
                accessibilityLabel="下个月"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => onChangeMonth(1)}
                style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}>
                <SymbolView
                  name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
                  size={18}
                  tintColor={theme.textSecondary}
                />
              </Pressable>
            </View>
          </View>

          <View style={styles.weekRow}>
            {weekdayLabels.map((label) => (
              <ThemedText key={label} style={styles.weekday} themeColor="textSecondary">
                {label}
              </ThemedText>
            ))}
          </View>

          <View style={styles.calendarGrid}>
            {calendarCells.map((day, index) => {
              const selected = day === activeDay;
              const hasRecords = day !== null && recordDays.has(day);
              return (
                <View key={`${day ?? 'empty'}-${index}`} style={styles.dayCell}>
                  {day !== null && (
                    <Pressable
                      accessibilityLabel={`${month + 1} 月 ${day} 日${hasRecords ? '，有记录' : ''}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => onSelectDay(day)}
                      style={({ pressed }) => [
                        styles.dayButton,
                        hasRecords && { backgroundColor: theme.backgroundElement },
                        selected && { backgroundColor: theme.accent },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText
                        style={[styles.dayLabel, selected && { color: theme.onAccent, fontWeight: '700' }]}>
                        {day}
                      </ThemedText>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        </View>

        <View style={[styles.tagsSection, { borderTopColor: theme.border }]}>
          <View style={styles.sectionHeading}>
            <ThemedText style={styles.sectionTitle}>标签</ThemedText>
            <ThemedText style={styles.sectionCount} themeColor="textSecondary">
              {tags.length}
            </ThemedText>
          </View>
          <View style={styles.tagList}>
            {tags.map((tag) => {
              const selected = tag.name === activeTag;
              return (
                <Pressable
                  key={tag.name}
                  accessibilityLabel={`标签 ${tag.name}，${tag.count} 条记录`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => onSelectTag(tag.name)}
                  style={({ pressed }) => [
                    styles.tagRow,
                    selected && { backgroundColor: theme.accentMuted },
                    pressed && styles.pressed,
                  ]}>
                  <View style={styles.tagNameGroup}>
                    <ThemedText style={[styles.hash, selected && { color: theme.accent }]}>#</ThemedText>
                    <ThemedText style={[styles.tagName, selected && { color: theme.accent, fontWeight: '700' }]}>
                      {tag.name}
                    </ThemedText>
                  </View>
                  <ThemedText style={styles.tagCount} themeColor="textSecondary">
                    {tag.count}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: '100%',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  panelHeader: {
    minHeight: 64,
    paddingHorizontal: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  connectionStatusDot: { width: 9, height: 9, borderRadius: 5 },
  connectionStatusLabel: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverSettingsIconFrame: {
    width: 30,
    height: 30,
    borderWidth: 1,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: { paddingBottom: Spacing.five },
  calendarSection: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.four },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
  monthControls: { flexDirection: 'row', gap: Spacing.one },
  monthButton: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  weekRow: { flexDirection: 'row', marginTop: Spacing.three, marginBottom: Spacing.one },
  weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 11, lineHeight: 18, fontWeight: '600' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  dayButton: { flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dayLabel: { fontSize: 12, lineHeight: 18, fontWeight: '500' },
  tagsSection: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.two, paddingTop: Spacing.four },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.two, marginBottom: Spacing.two },
  sectionTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  sectionCount: { fontSize: 12, lineHeight: 18 },
  tagList: { gap: 2 },
  tagRow: { minHeight: 44, borderRadius: 12, paddingHorizontal: Spacing.two, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tagNameGroup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  hash: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  tagName: { flexShrink: 1, fontSize: 14, lineHeight: 20, fontWeight: '500' },
  tagCount: { fontSize: 12, lineHeight: 18 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
