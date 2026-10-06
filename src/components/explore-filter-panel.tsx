import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, type DimensionValue, Easing, Linking, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { Pressable } from '@/components/haptic-pressable';

import { FeedbackDialog } from '@/components/feedback-dialog';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ThemeModeSwitch } from '@/components/theme-mode-switch';
import { TagOrderEditor } from '@/components/tag-order-editor';
import { getTagOrder, saveTagOrder } from '@/storage/tag-order';
import { orderTags } from '@/storage/tag-order-rules';
import { TagGrowthCurve } from '@/components/tag-growth-curve';
import type { Memo } from '@/types/memo';

export type TagCount = {
  name: string;
  count: number;
};

export type ServerConnectionStatus = 'unconfigured' | 'connecting' | 'connected' | 'failed';

type ExploreFilterPanelProps = {
  statisticsMemos?: Memo[];
  statisticsVisible?: boolean;
  onSelectDate?: (date: Date | null) => void;
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
  showingHidden?: boolean;
  authenticating?: boolean;
  onSelectVisibility?: (hidden: boolean) => void;
};

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];

// REQ-050: The user explicitly selected the public repository, not private origin.
const PUBLIC_REPOSITORY_URL = 'https://github.com/wuqi2753/sprout-public';

async function openPublicRepository(showFailure: (message: string) => void) {
  try {
    await Linking.openURL(PUBLIC_REPOSITORY_URL);
  } catch {
    const message = '无法打开 GitHub 公开仓库，请检查浏览器后重试。';
    showFailure(message);
  }
}

function getCalendarCells(year: number, month: number) {
  const leadingEmptyCells = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return [
    ...Array.from({ length: leadingEmptyCells }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
}

export function ExploreFilterPanel({
  statisticsMemos,
  statisticsVisible = true,
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
  showingHidden = false,
  authenticating = false,
  onSelectVisibility,
}: ExploreFilterPanelProps) {
  const theme = useTheme();
  const [linkError, setLinkError] = useState<string>();
  // REQ-059: Custom order affects sidebar presentation only.
  const [tagOrder, setTagOrder] = useState<string[]>([]);
  const [sorting, setSorting] = useState(false);
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [tagListHeight, setTagListHeight] = useState(0);
  const [tagExpansion] = useState(() => new Animated.Value(1));
  const [reduceMotion, setReduceMotion] = useState(false);
  // REQ-005: replay a temporary location cue without changing the tag filter.
  const [tagHighlight] = useState(() => new Animated.Value(0));
  useEffect(() => {
    tagHighlight.stopAnimation();
    tagHighlight.setValue(statisticsVisible && !tagsCollapsed && activeTag !== null ? 1 : 0);
    if (!statisticsVisible || tagsCollapsed || activeTag === null) return;
    const cue = Animated.sequence([
      Animated.delay(600),
      Animated.timing(tagHighlight, { toValue: 0, duration: reduceMotion ? 0 : 400, useNativeDriver: true }),
    ]);
    cue.start();
    return () => { cue.stop(); tagHighlight.stopAnimation(); tagHighlight.setValue(0); };
  }, [statisticsVisible, tagsCollapsed, activeTag, reduceMotion, tagHighlight]);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (mounted) setReduceMotion(enabled); }).catch(() => {
      // If the OS preference cannot be read, use the accessible no-motion fallback.
      if (mounted) setReduceMotion(true);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  function toggleTags() {
    const collapsed = !tagsCollapsed;
    setTagsCollapsed(collapsed);
    tagExpansion.stopAnimation();
    Animated.timing(tagExpansion, { toValue: collapsed ? 0 : 1, duration: reduceMotion ? 0 : 220, easing: Easing.inOut(Easing.ease), useNativeDriver: false }).start();
  }
  const [orderLoaded, setOrderLoaded] = useState(false);
  const [orderError, setOrderError] = useState(false);
  async function loadTagOrder() {
    try { const names = await getTagOrder(); setTagOrder(names); setOrderLoaded(true); setOrderError(false); }
    catch { setOrderError(true); }
  }
  useEffect(() => {
    let mounted = true;
    getTagOrder().then((names) => {
      if (mounted) { setTagOrder(names); setOrderLoaded(true); }
    }).catch(() => { if (mounted) setOrderError(true); });
    return () => { mounted = false; };
  }, []);
  const sortedTags = orderTags(tags, tagOrder);
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
          <Svg width={24} height={24} viewBox="0 0 24 24" accessible={false}>
            <Path d="M7 3.5h10l5 8.5-5 8.5H7L2 12Z" fill="none" stroke={theme.textSecondary} strokeWidth={2} strokeLinejoin="round" />
            <Circle cx={12} cy={12} r={3} fill="none" stroke={theme.textSecondary} strokeWidth={2} />
          </Svg>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {statisticsMemos ? <TagGrowthCurve memos={statisticsMemos} visible={statisticsVisible} /> : <View style={styles.calendarSection}>
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

        }
        {onSelectVisibility && (
          <View style={styles.visibilitySection}>
            {[false, true].map((hidden) => (
              <Pressable
                key={String(hidden)}
                accessibilityRole="button"
                accessibilityLabel={hidden ? (authenticating ? '正在验证隐藏笔记' : '隐藏笔记，需要生物识别验证') : '全部笔记'}
                accessibilityState={{ selected: showingHidden === hidden, disabled: hidden && authenticating, busy: hidden && authenticating }}
                disabled={hidden && authenticating}
                onPress={() => onSelectVisibility(hidden)}
                style={({ pressed }) => [styles.visibilityRow, showingHidden === hidden && { backgroundColor: theme.sidebarSelectedBackground }, pressed && styles.pressed]}>
                <View style={styles.visibilityLabelGroup}>
                  <Svg width={20} height={20} viewBox="0 0 24 24" accessible={false}>
                    {hidden ? (
                      <>
                        <Path d="M7.5 10V7a4.5 4.5 0 0 1 9 0v3" fill="none" stroke={showingHidden === hidden ? theme.sidebarSelectedText : theme.text} strokeWidth={1.6} strokeLinecap="round" />
                        <Rect x={4.5} y={10} width={15} height={11} rx={2.5} fill="none" stroke={showingHidden === hidden ? theme.sidebarSelectedText : theme.text} strokeWidth={1.6} />
                        <Path d="M12 14v3" stroke={showingHidden === hidden ? theme.sidebarSelectedText : theme.text} strokeWidth={1.6} strokeLinecap="round" />
                      </>
                    ) : (
                      <>
                        {[{ x: 3, y: 3 }, { x: 14, y: 3 }, { x: 3, y: 14 }, { x: 14, y: 14 }].map(({ x, y }) => (
                          <Rect key={`${x}-${y}`} x={x} y={y} width={7} height={7} rx={1.8} fill={showingHidden === hidden ? theme.sidebarSelectedText : theme.text} />
                        ))}
                      </>
                    )}
                  </Svg>
                <ThemedText style={[styles.sidebarLabel, showingHidden === hidden && { color: theme.sidebarSelectedText, fontWeight: '700' }]}>
                  {hidden ? (authenticating ? '正在验证…' : '隐藏笔记') : '全部笔记'}
                </ThemedText>
                </View>
                {hidden && authenticating && <ActivityIndicator size="small" color={theme.accent} />}
              </Pressable>
            ))}
          </View>
        )}

        <View style={[styles.tagsSection, { borderTopColor: theme.border }]}>
          <View style={styles.sectionHeading}>
            <Pressable accessibilityRole="button" accessibilityLabel={tagsCollapsed ? '展开全部标签' : '收起全部标签'} accessibilityState={{ expanded: !tagsCollapsed }} onPress={toggleTags} style={({ pressed }) => [styles.tagHeadingButton, pressed && { opacity: 0.7 }]}>
              <ThemedText style={styles.tagHeadingLabel} themeColor="sidebarTagHeading">{tagsCollapsed ? '全部标签...' : '全部标签'}</ThemedText>
            </Pressable>
            {!tagsCollapsed && <Pressable accessibilityLabel="标签排序" accessibilityRole="button" disabled={!orderLoaded} onPress={() => setSorting(true)} style={({ pressed }) => [styles.sortButton, pressed && { opacity: 0.7 }]}>
              <Svg width={18} height={18} viewBox="0 0 24 24" accessible={false}>
                <Path d="M3 7h11.8m4.4 0H21M3 17h1.8m4.4 0H21" fill="none" stroke={theme.textSecondary} strokeWidth={1.6} strokeLinecap="round" />
                <Circle cx={17} cy={7} r={2.2} fill="none" stroke={theme.textSecondary} strokeWidth={1.6} />
                <Circle cx={7} cy={17} r={2.2} fill="none" stroke={theme.textSecondary} strokeWidth={1.6} />
              </Svg>
            </Pressable>}
          </View>
          {orderError && <Pressable accessibilityRole="button" onPress={() => { void loadTagOrder(); }} style={{ padding: 12 }}><ThemedText style={{ color: theme.danger }}>无法读取标签排序，点按重试</ThemedText></Pressable>}
          <Animated.View pointerEvents={tagsCollapsed ? 'none' : 'auto'} accessibilityElementsHidden={tagsCollapsed} importantForAccessibility={tagsCollapsed ? 'no-hide-descendants' : 'auto'} style={{ overflow: 'hidden', opacity: tagExpansion, height: tagListHeight ? tagExpansion.interpolate({ inputRange: [0, 1], outputRange: [0, tagListHeight] }) : undefined }}>
          <View onLayout={(event) => setTagListHeight(event.nativeEvent.layout.height)}>
            {sortedTags.map((tag) => {
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
                    pressed && styles.pressed,
                  ]}>
                  {selected && <Animated.View pointerEvents="none" accessible={false} style={[StyleSheet.absoluteFill, { borderRadius: 12, backgroundColor: theme.sidebarSelectedBackground, opacity: tagHighlight }]} />}
                  <View style={styles.tagNameGroup}>
                    <ThemedText style={styles.hash}>#</ThemedText>
                    <ThemedText style={styles.tagName}>
                      {tag.name}
                    </ThemedText>
                  </View>
                  <ThemedText numberOfLines={1} adjustsFontSizeToFit style={styles.tagCount} themeColor="textSecondary">
                    {tag.count}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
          </Animated.View>
        </View>
      </ScrollView>
      <View style={[styles.sidebarFooter, { borderTopColor: theme.border }]}>
        <ThemeModeSwitch />
        <Pressable accessibilityRole="link" accessibilityLabel="打开 GitHub 公开仓库" onPress={() => { void openPublicRepository(setLinkError); }}
          style={({ pressed }) => [styles.repositoryLink, pressed && { opacity: 0.65 }]}>
          {/* GitHub mark from Simple Icons (CC0), colored with the app theme. */}
          <Svg width={22} height={22} viewBox="0 0 24 24" fill={theme.text} accessible={false}>
            <Path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385 .6 .113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495 .998 .108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176 .765 .84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92 .42 .36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315 .21 .69 .825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </Svg>
        </Pressable>
      </View>
      {sorting && <TagOrderEditor names={sortedTags.map((tag) => tag.name)} defaultNames={orderTags(tags, []).map((tag) => tag.name)} onClose={() => setSorting(false)} onSave={async (names) => {
        await saveTagOrder(names);
        setTagOrder(names);
        setSorting(false);
      }} />}
      <FeedbackDialog visible={linkError !== undefined} title="无法打开链接" message={linkError} onDismiss={() => setLinkError(undefined)} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: '100%',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  sidebarFooter: { borderTopWidth: StyleSheet.hairlineWidth, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  repositoryLink: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
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
  scrollContent: { paddingBottom: Spacing.five },
  visibilitySection: { paddingHorizontal: Spacing.two, paddingBottom: 12, gap: Spacing.one },
  visibilityRow: { minHeight: 48, paddingHorizontal: Spacing.two, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 12 },
  visibilityLabelGroup: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  calendarSection: { paddingHorizontal: Spacing.three, paddingTop: Spacing.four, paddingBottom: 12 },
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
  tagsSection: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: Spacing.two, paddingTop: Spacing.one },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: Spacing.two },
  sortButton: { width: 48, height: 44, alignItems: 'center', paddingTop: 12, justifyContent: 'center' },
  tagHeadingLabel: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  tagHeadingButton: { flex: 1, minHeight: 44, paddingTop: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  sidebarLabel: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  tagRow: { minHeight: 44, borderRadius: 12, paddingHorizontal: Spacing.two, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tagNameGroup: { flex: 1, minWidth: 0, paddingRight: 8, flexDirection: 'row', alignItems: 'center', gap: 7 },
  hash: { width: 20, textAlign: 'center', fontSize: 16, lineHeight: 24, fontWeight: '700' },
  tagName: { flexShrink: 1, fontSize: 16, lineHeight: 24, fontWeight: '700' },
  tagCount: { width: 32, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
