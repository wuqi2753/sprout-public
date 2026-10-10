// REQ-023: docs/stories/v0.2.0/REQ-023-refine-core-screen-visuals.md
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ExploreFilterPanel, type TagCount } from '@/components/explore-filter-panel';
import { Pressable } from '@/components/haptic-pressable';
import { MemoSyncStatus } from '@/components/memo-sync-status';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useServerConnection } from '@/hooks/use-server-connection';
import { ThemedText } from '@/components/themed-text';

type ExploreMemo = {
  id: string;
  body: string;
  day: number;
  month: number;
  tags: string[];
  time: string;
  year: number;
};

const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth();

const memos: ExploreMemo[] = [
  {
    id: 'design',
    body: '少一点整理，多一点真实。先写下来，之后再决定它要去哪里。',
    day: 24,
    month: currentMonth,
    tags: ['想法', '产品'],
    time: '09:42',
    year: currentYear,
  },
  {
    id: 'walk',
    body: '傍晚散步时想到，好的记录工具应该让人忘记工具本身。',
    day: 22,
    month: currentMonth,
    tags: ['生活', '想法'],
    time: '18:27',
    year: currentYear,
  },
  {
    id: 'reading',
    body: '今天读完一章。真正值得记住的不是结论，而是结论改变了哪个问题。',
    day: 18,
    month: currentMonth,
    tags: ['阅读'],
    time: '22:08',
    year: currentYear,
  },
  {
    id: 'server',
    body: '客户端只做入口，数据回到自己的 Server。边界清楚以后，产品也会更安静。',
    day: 15,
    month: currentMonth,
    tags: ['产品', '开发'],
    time: '14:13',
    year: currentYear,
  },
  {
    id: 'older',
    body: '把复杂留在系统里，把简单留给使用者。',
    day: 27,
    month: (currentMonth + 11) % 12,
    tags: ['想法'],
    time: '10:05',
    year: currentMonth === 0 ? currentYear - 1 : currentYear,
  },
];

function shiftMonth(year: number, month: number, offset: number) {
  const shiftedDate = new Date(year, month + offset, 1);
  return { year: shiftedDate.getFullYear(), month: shiftedDate.getMonth() };
}

function formatMemoDate(memo: ExploreMemo) {
  return `${memo.year}-${String(memo.month + 1).padStart(2, '0')}-${String(memo.day).padStart(2, '0')} ${memo.time}`;
}

export default function ExploreScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { connectionStatus, serverUrl, retryConnection } = useServerConnection();
  const { width } = useWindowDimensions();
  const isWide = width >= 860;
  const [filterOpen, setFilterOpen] = useState(isWide);
  const [visibleYear, setVisibleYear] = useState(currentYear);
  const [visibleMonth, setVisibleMonth] = useState(currentMonth);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const tags = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>();
    memos.forEach((memo) => memo.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name));
  }, []);

  const recordDays = useMemo(
    () =>
      new Set(
        memos
          .filter((memo) => memo.year === visibleYear && memo.month === visibleMonth)
          .map((memo) => memo.day),
      ),
    [visibleMonth, visibleYear],
  );

  const filteredMemos = useMemo(
    () =>
      memos.filter((memo) => {
        const matchesDate =
          activeDay === null ||
          (memo.year === visibleYear && memo.month === visibleMonth && memo.day === activeDay);
        const matchesTag = activeTag === null || memo.tags.includes(activeTag);
        return matchesDate && matchesTag;
      }),
    [activeDay, activeTag, visibleMonth, visibleYear],
  );

  function changeMonth(offset: number) {
    const nextMonth = shiftMonth(visibleYear, visibleMonth, offset);
    setVisibleYear(nextMonth.year);
    setVisibleMonth(nextMonth.month);
    setActiveDay(null);
  }

  function clearFilters() {
    setActiveDay(null);
    setActiveTag(null);
  }

  function openServerConnection() {
    setFilterOpen(false);
    router.push('/server-connection');
  }

  function selectTag(tag: string) {
    setActiveTag((currentTag) => (currentTag === tag ? null : tag));
    if (!isWide) setFilterOpen(false);
  }

  const filterPanel = (
    <ExploreFilterPanel
      activeDay={activeDay}
      activeTag={activeTag}
      connectionStatus={connectionStatus}
                serverUrl={serverUrl}
                onRetryConnection={retryConnection}
      month={visibleMonth}
      onAddServer={openServerConnection}
      onChangeMonth={changeMonth}
      onSelectDay={(day) => setActiveDay((currentDay) => (currentDay === day ? null : day))}
      onSelectTag={selectTag}
      recordDays={recordDays}
      tags={tags}
      year={visibleYear}
    />
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={styles.workspace}>
        {isWide && filterOpen && filterPanel}

        <View style={styles.mainColumn}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <View style={styles.headerLeading}>
              <Pressable
                accessibilityLabel="返回记录"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => router.back()}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <SymbolView
                  name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                  size={21}
                  tintColor={theme.text}
                />
              </Pressable>
              <View>
                <ThemedText style={styles.title}>浏览</ThemedText>
                <ThemedText style={styles.subtitle} themeColor="textSecondary">
                  找回写过的内容
                </ThemedText>
              </View>
            </View>
            <Pressable
              accessibilityLabel={filterOpen ? '收起筛选' : '展开筛选'}
              accessibilityRole="button"
              accessibilityState={{ expanded: filterOpen }}
              onPress={() => setFilterOpen((currentValue) => !currentValue)}
              style={({ pressed }) => [
                styles.filterButton,
                filterOpen && { backgroundColor: theme.accentMuted },
                pressed && styles.pressed,
              ]}>
              <SymbolView
                name={{ ios: 'line.3.horizontal.decrease', android: 'filter_list', web: 'filter_list' }}
                size={19}
                tintColor={filterOpen ? theme.accent : theme.textSecondary}
              />
              <ThemedText style={[styles.filterLabel, filterOpen && { color: theme.accent }]}>筛选</ThemedText>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.feedScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.feedColumn}>
              {(activeDay !== null || activeTag !== null) && (
                <View style={styles.filterSummary}>
                  <View style={styles.activeFilters}>
                    {activeDay !== null && (
                      <View style={[styles.filterChip, { backgroundColor: theme.accentMuted }]}>
                        <SymbolView
                          name={{ ios: 'calendar', android: 'event', web: 'event' }}
                          size={14}
                          tintColor={theme.accent}
                        />
                        <ThemedText style={[styles.filterChipLabel, { color: theme.accent }]}>
                          {visibleMonth + 1} 月 {activeDay} 日
                        </ThemedText>
                      </View>
                    )}
                    {activeTag !== null && (
                      <View style={[styles.filterChip, { backgroundColor: theme.accentMuted }]}>
                        <ThemedText style={[styles.filterChipLabel, { color: theme.accent }]}>#{activeTag}</ThemedText>
                      </View>
                    )}
                  </View>
                  <Pressable
                    accessibilityLabel="清除全部筛选"
                    accessibilityRole="button"
                    onPress={clearFilters}
                    style={({ pressed }) => pressed && styles.pressed}>
                    <ThemedText style={[styles.clearLabel, { color: theme.accent }]}>清除</ThemedText>
                  </Pressable>
                </View>
              )}

              <View style={styles.feedHeading}>
                <ThemedText style={styles.feedTitle}>记录</ThemedText>
                <ThemedText style={styles.feedCount} themeColor="textSecondary">
                  {filteredMemos.length} 条
                </ThemedText>
              </View>

              {filteredMemos.length > 0 ? (
                <View style={styles.memoList}>
                  {filteredMemos.map((memo) => (
                    <View key={memo.id} style={[styles.memoCard, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                      <View style={styles.memoMetadata}>
                        <ThemedText style={styles.memoDate} themeColor="textSecondary">
                          {formatMemoDate(memo)}
                        </ThemedText>
                        <MemoSyncStatus synced={false} />
                      </View>
                      <ThemedText style={styles.memoBody}>{memo.body}</ThemedText>
                      <View style={styles.memoTags}>
                        {memo.tags.map((tag) => (
                          <Pressable
                            key={tag}
                            accessibilityLabel={`按标签 ${tag} 筛选`}
                            accessibilityRole="button"
                            onPress={() => setActiveTag(tag)}
                            style={({ pressed }) => [
                              styles.memoTag,
                              pressed && styles.pressed,
                            ]}>
                            <View style={[styles.memoTagPill, { backgroundColor: theme.tagBackground }]}>
                              <ThemedText style={[styles.memoTagLabel, { color: theme.tag }]}>
                                #{tag}
                              </ThemedText>
                            </View>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  ))}
                </View>
              ) : (
                <View style={[styles.emptyState, { borderColor: theme.border }]}>
                  <SymbolView
                    name={{ ios: 'tray', android: 'inbox', web: 'inbox' }}
                    size={27}
                    tintColor={theme.textSecondary}
                  />
                  <ThemedText style={styles.emptyTitle}>没有符合条件的记录</ThemedText>
                  <ThemedText style={styles.emptyBody} themeColor="textSecondary">
                    清除筛选后查看全部内容。
                  </ThemedText>
                  <Pressable
                    accessibilityRole="button"
                    onPress={clearFilters}
                    style={({ pressed }) => [
                      styles.emptyButton,
                      { borderColor: theme.border },
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText style={styles.emptyButtonLabel}>清除筛选</ThemedText>
                  </Pressable>
                </View>
              )}
            </View>
          </ScrollView>
        </View>

        {!isWide && (
          <Modal
            animationType="fade"
            onRequestClose={() => setFilterOpen(false)}
            statusBarTranslucent
            transparent
            visible={filterOpen}>
            <View style={styles.modalOverlay}>
              <SafeAreaView
                edges={['top', 'bottom']}
                style={[styles.drawerSafeArea, { backgroundColor: theme.surface }]}>
                {filterPanel}
              </SafeAreaView>
              <Pressable
                accessibilityLabel="关闭筛选"
                accessibilityRole="button"
                onPress={() => setFilterOpen(false)}
                style={styles.backdrop}
              />
            </View>
          </Modal>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  workspace: { flex: 1, flexDirection: 'row' },
  mainColumn: { flex: 1, minWidth: 0 },
  header: {
    minHeight: 72,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  iconButton: { width: 48, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.4 },
  subtitle: { fontSize: 12, lineHeight: 17, fontWeight: '500' },
  filterButton: { minHeight: 48, borderRadius: 13, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterLabel: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  feedScroll: { alignItems: 'center', paddingHorizontal: Spacing.three, paddingTop: Spacing.four, paddingBottom: Spacing.six },
  feedColumn: { width: '100%', maxWidth: MaxContentWidth },
  filterSummary: { minHeight: 40, marginBottom: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  activeFilters: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  filterChip: { minHeight: 32, borderRadius: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterChipLabel: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  clearLabel: { minWidth: 48, minHeight: 48, fontSize: 13, lineHeight: 18, fontWeight: '700', paddingHorizontal: Spacing.two, textAlignVertical: 'center' },
  feedHeading: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: Spacing.two },
  feedTitle: { fontSize: 17, lineHeight: 24, fontWeight: '700' },
  feedCount: { fontSize: 13, lineHeight: 18 },
  memoList: { gap: 12 },
  memoCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: Spacing.three, paddingTop: 12, paddingBottom: Spacing.three },
  memoMetadata: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  memoDate: { fontSize: 12, lineHeight: 18, fontWeight: '500' },
  memoBody: { fontSize: 16, lineHeight: 25, fontWeight: '400', marginTop: Spacing.two },
  memoTags: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.three },
  memoTag: { minWidth: 48, minHeight: 48, justifyContent: 'center' },
  memoTagPill: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  memoTagLabel: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
  emptyState: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, alignItems: 'center', paddingVertical: Spacing.five, paddingHorizontal: Spacing.three },
  emptyTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', marginTop: Spacing.three },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: Spacing.one },
  emptyButton: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, justifyContent: 'center', paddingHorizontal: Spacing.three, marginTop: Spacing.three },
  emptyButtonLabel: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  modalOverlay: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(18, 20, 17, 0.36)' },
  drawerSafeArea: { width: 292, height: '100%' },
  backdrop: { flex: 1 },
  pressed: { opacity: 0.72 },
});
