import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { Keyboard, Modal, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { hasSearchFilters, type MemoSearchFilters, type MemoSearchSort } from '@/search/memo-search';

// REQ-055: flomo-style search header and shortcuts, using Sprout's semantic colors.
export function MemoSearchHeader({ query, filters, onQueryChange, onOpenFilters, onCancel, onSubmit }: {
  query: string; filters: MemoSearchFilters; onQueryChange: (query: string) => void; onOpenFilters: () => void; onCancel: () => void; onSubmit: () => void;
}) {
  const theme = useTheme();
  return <View style={styles.header}>
    <View style={[styles.searchField, { backgroundColor: theme.backgroundElement }]}>
      <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={22} tintColor={theme.textSecondary} />
      <TextInput autoFocus accessibilityLabel="搜索正文或标签" placeholder="搜索" placeholderTextColor={theme.textSecondary}
        value={query} onChangeText={onQueryChange} returnKeyType="search" onSubmitEditing={() => { Keyboard.dismiss(); onSubmit(); }}
        selectionColor={theme.accent} style={[styles.input, { color: theme.text }]} />
      <Pressable accessibilityLabel="搜索筛选" accessibilityRole="button" accessibilityState={{ selected: hasSearchFilters(filters) }}
        onPress={() => { Keyboard.dismiss(); onOpenFilters(); }} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <Svg width={24} height={24} viewBox="0 0 24 24" accessible={false}>
          <Path d="M3 6h18M6 12h12M9 18h6" stroke={hasSearchFilters(filters) ? theme.accent : theme.text} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </Pressable>
      {query.length > 0 && <Pressable accessibilityLabel="清空关键词" accessibilityRole="button" onPress={() => onQueryChange('')}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <Svg width={24} height={24} viewBox="0 0 24 24" accessible={false}>
          <Path d="M6 6l12 12M18 6 6 18" fill="none" stroke={theme.text} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </Pressable>}
    </View>
    <Pressable accessibilityLabel="取消搜索" accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
      <ThemedText style={styles.cancelLabel}>取消</ThemedText>
    </Pressable>
  </View>;
}

export function MemoRecentSearches({ keywords, onSelect, onClear }: { keywords: string[]; onSelect: (keyword: string) => void; onClear: () => void }) {
  const theme = useTheme();
  if (keywords.length === 0) return null;
  return <View style={styles.recentSearches}>
    <View style={styles.recentHeading}>
      <ThemedText style={styles.sectionLabel} themeColor="textSecondary">最近搜索</ThemedText>
      <Pressable accessibilityLabel="清空最近搜索" accessibilityRole="button" onPress={onClear} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <Svg width={22} height={22} viewBox="0 0 24 24" accessible={false}>
          <Path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" fill="none" stroke={theme.textSecondary} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </Pressable>
    </View>
    <View style={styles.shortcutRow}>{keywords.map((keyword) => <Pressable key={keyword} accessibilityLabel={`搜索 ${keyword}`} accessibilityRole="button" onPress={() => onSelect(keyword)} style={({ pressed }) => [styles.recentKeyword, { backgroundColor: theme.backgroundElement }, pressed && styles.pressed]}>
      <ThemedText numberOfLines={1} style={styles.shortcutLabel}>{keyword}</ThemedText>
    </Pressable>)}</View>
  </View>;
}

export function MemoSearchShortcuts({ onSelect }: { onSelect: (shortcut: 'untagged' | 'images' | 'files') => void }) {
  const theme = useTheme();
  return <View style={styles.shortcuts}>
    <ThemedText style={styles.sectionLabel} themeColor="textSecondary">快捷搜索</ThemedText>
    <View style={styles.shortcutRow}>
      {(['untagged', 'images', 'files'] as const).map((shortcut) => <Pressable key={shortcut}
        accessibilityLabel={shortcut === 'untagged' ? '搜索无标签笔记' : shortcut === 'images' ? '搜索有图片笔记' : '搜索有文件笔记'} accessibilityRole="button"
        onPress={() => { Keyboard.dismiss(); onSelect(shortcut); }} style={({ pressed }) => [styles.shortcutTouchTarget, pressed && styles.pressed]}>
        <View style={[styles.shortcut, { backgroundColor: theme.backgroundElement }]}>
        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={theme.text} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" accessible={false}>
          {shortcut === 'untagged' ? <><Path d="M3 3h8l10 10a2 2 0 0 1 0 3l-5 5a2 2 0 0 1-3 0L3 11Z" /><Circle cx={7.5} cy={7.5} r={1} /></>
            : shortcut === 'images' ? <><Rect x={3} y={3} width={18} height={18} rx={2} /><Circle cx={8} cy={8} r={1.5} /><Path d="m4 19 6-6 3 3 4-5 4 4" /></>
            : <><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><Path d="M14 2v6h6M8 13h8M8 17h5" /></>}
        </Svg>
        <ThemedText style={styles.shortcutLabel}>{shortcut === 'untagged' ? '无标签' : shortcut === 'images' ? '有图片' : '有文件'}</ThemedText>
        </View>
      </Pressable>)}
    </View>
  </View>;
}

const sortOptions: { value: MemoSearchSort; label: string }[] = [
  { value: 'created-desc', label: '创建时间，从新到旧' }, { value: 'created-asc', label: '创建时间，从旧到新' },
  { value: 'edited-desc', label: '编辑时间，从新到旧' }, { value: 'edited-asc', label: '编辑时间，从旧到新' },
];

export function MemoSearchSummary({ count, order, onOrderChange }: { count: number; order: MemoSearchSort; onOrderChange: (order: MemoSearchSort) => void }) {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const sortButton = useRef<View>(null);
  const [sortMenuTop, setSortMenuTop] = useState<number>();
  return <View style={styles.summary}>
    <ThemedText style={styles.count} themeColor="textSecondary">笔记（{count}）</ThemedText>
    <View ref={sortButton} collapsable={false}>
      <Pressable accessibilityLabel="搜索结果排序" accessibilityRole="button" accessibilityState={{ expanded: sortMenuTop !== undefined }}
        onPress={() => { Keyboard.dismiss(); sortButton.current?.measureInWindow((_x, y, _width, buttonHeight) => setSortMenuTop(Math.min(y + buttonHeight, height - 216))); }}
        style={({ pressed }) => [styles.sortButton, pressed && styles.pressed]}>
        <ThemedText style={styles.sortLabel} themeColor="textSecondary">排序</ThemedText>
        <Svg width={12} height={18} viewBox="0 0 12 18" accessible={false}><Path d="m3 6 3-3 3 3M3 12l3 3 3-3" fill="none" stroke={theme.textSecondary} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></Svg>
      </Pressable>
    </View>
    <Modal transparent statusBarTranslucent visible={sortMenuTop !== undefined} animationType="fade" onRequestClose={() => setSortMenuTop(undefined)}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭排序选项" onPress={() => setSortMenuTop(undefined)} style={StyleSheet.absoluteFill} />
      <View style={[styles.sortMenu, { top: Math.max(48, sortMenuTop ?? 48), backgroundColor: theme.backgroundElement }]}>
        {sortOptions.map((option) => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: order === option.value }} accessibilityLabel={option.label}
          onPress={() => { onOrderChange(option.value); setSortMenuTop(undefined); }} style={({ pressed }) => [styles.sortOption, pressed && styles.pressed]}>
          <ThemedText style={[styles.sortOptionLabel, order === option.value && { color: theme.accent }]}>{option.label}</ThemedText>
          {order === option.value && <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.accent} />}
        </Pressable>)}
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  recentSearches: { paddingTop: 24, gap: 4 },
  recentHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recentKeyword: { maxWidth: '100%', minHeight: 48, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 8 },
  searchField: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, borderRadius: 12 },
  input: { flex: 1, minWidth: 0, fontSize: 17, paddingHorizontal: 8, paddingVertical: 12, minHeight: 48 },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  cancel: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  cancelLabel: { fontSize: 16, fontWeight: '400' },
  shortcuts: { paddingTop: 8, gap: 10 },
  sectionLabel: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  shortcutRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  shortcutTouchTarget: { minHeight: 48, justifyContent: 'center' },
  shortcut: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: 7, paddingVertical: 8, borderRadius: 6 },
  shortcutLabel: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8, gap: 8 },
  count: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  sortButton: { minHeight: 48, minWidth: 48, flexDirection: 'row', alignItems: 'center', gap: 4 },
  sortLabel: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  sortMenu: { position: 'absolute', right: 16, width: 244, borderRadius: 10, paddingVertical: 4, elevation: 6, boxShadow: '0 4px 20px rgba(0,0,0,0.16)' },
  sortOption: { minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sortOptionLabel: { fontSize: 15, fontWeight: '400', flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
