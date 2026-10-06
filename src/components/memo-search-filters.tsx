import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { emptySearchFilters, hasSearchFilters, localDateLabel, searchFilterError, type MemoSearchFilters, type SearchContentRange, type SearchDateRange, type SearchTagRange } from '@/search/memo-search';

const dateOptions: { value: SearchDateRange; label: string }[] = [{ value: 'all', label: '不限时间' }, { value: 'week', label: '本周' }, { value: 'month', label: '本月' }, { value: 'custom', label: '自定义' }];
const tagOptions: { value: SearchTagRange; label: string }[] = [{ value: 'all', label: '不限标签' }, { value: 'untagged', label: '无标签' }, { value: 'include', label: '包含指定标签' }, { value: 'exclude', label: '排除指定标签' }];
const contentOptions: { value: SearchContentRange; label: string }[] = [{ value: 'all', label: '所有内容' }, { value: 'images', label: '有图片' }, { value: 'files', label: '有文件' }];
type FilterMenu = 'date' | 'tag' | 'content';

// REQ-056: Mounted once per opening so cancelled edits never alter applied filters.
export function MemoSearchFiltersSheet({ filters, availableTags, onApply, onCancel }: {
  filters: MemoSearchFilters; availableTags: string[]; onApply: (filters: MemoSearchFilters) => void; onCancel: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [overlayHeight, setOverlayHeight] = useState(height);
  const availableSheetHeight = Math.max(120, Math.min(height - insets.top - 24, overlayHeight - insets.top - 12));
  const [draft, setDraft] = useState<MemoSearchFilters>(() => ({ ...filters, tags: [...filters.tags] }));
  const [page, setPage] = useState<'filters' | 'tags' | 'dates'>('filters');
  const [menu, setMenu] = useState<FilterMenu>();
  const [menuAnchor, setMenuAnchor] = useState(0);
  const [rowPositions, setRowPositions] = useState<Partial<Record<FilterMenu, number>>>({});
  const [error, setError] = useState<string>();
  const [tagQuery, setTagQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [dateEndpoint, setDateEndpoint] = useState<'start' | 'end'>('start');
  const today = new Date();
  const [calendarMonth, setCalendarMonth] = useState({ year: today.getFullYear(), month: today.getMonth() });

  function returnToFilters() { Keyboard.dismiss(); setPage('filters'); setError(undefined); }
  function cancelOrBack() {
    if (menu) { setMenu(undefined); return; }
    if (page !== 'filters') { returnToFilters(); return; }
    Keyboard.dismiss(); onCancel();
  }
  function openMenu(nextMenu: FilterMenu) {
    setMenuAnchor(rowPositions[nextMenu] ?? 56);
    setMenu(nextMenu);
    setError(undefined);
  }
  function openDates(endpoint: 'start' | 'end' = 'start', nextDraft = draft) {
    setDateStart(nextDraft.startDate || localDateLabel(today));
    setDateEnd(nextDraft.endDate || localDateLabel(today));
    setDateEndpoint(endpoint);
    const parts = (endpoint === 'start' ? nextDraft.startDate : nextDraft.endDate)?.split('-').map(Number);
    setCalendarMonth(parts?.length === 3 ? { year: parts[0], month: parts[1] - 1 } : { year: today.getFullYear(), month: today.getMonth() });
    setPage('dates'); setError(undefined);
  }
  function confirm() {
    if (page === 'tags') {
      if (selectedTags.length === 0) { setError('请至少选择一个指定标签。'); return; }
      setDraft({ ...draft, tags: selectedTags }); returnToFilters(); return;
    }
    if (page === 'dates') {
      const next = { ...draft, dateRange: 'custom' as const, startDate: dateStart, endDate: dateEnd };
      const message = searchFilterError({ ...next, tagRange: 'all' });
      if (message) { setError(message); return; }
      setDraft(next); returnToFilters(); return;
    }
    const message = searchFilterError(draft);
    if (message) { setError(message); return; }
    Keyboard.dismiss(); onApply(draft);
  }
  function chooseOption(value: string) {
    if (menu === 'date') {
      if (value === 'custom') {
        // Choose dates before committing the custom range to the filter draft.
        openDates();
      } else setDraft({ ...draft, dateRange: value as SearchDateRange, startDate: '', endDate: '' });
    }
    if (menu === 'tag') setDraft({ ...draft, tagRange: value as SearchTagRange, tags: value === 'include' || value === 'exclude' ? draft.tags : [] });
    if (menu === 'content') setDraft({ ...draft, contentRange: value as SearchContentRange });
    setMenu(undefined);
  }
  function shiftCalendar(offset: number) {
    const date = new Date(calendarMonth.year, calendarMonth.month + offset, 1);
    setCalendarMonth({ year: date.getFullYear(), month: date.getMonth() });
  }
  function rangeRow(label: string, value: string, onPress: () => void, menuType?: FilterMenu) {
    return <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label}，${value}`} onPress={onPress}
      onLayout={menuType ? (event) => { const y = event.nativeEvent.layout.y; setRowPositions((current) => current[menuType] === y ? current : { ...current, [menuType]: y }); } : undefined}
      style={({ pressed }) => [styles.rangeRow, pressed && styles.pressed]}>
      <ThemedText style={styles.rowLabel}>{label}</ThemedText>
      <View style={styles.rowValue}>
        <ThemedText style={styles.valueLabel} themeColor="textSecondary" numberOfLines={2}>{value}</ThemedText>
        {menuType ? <Svg width={12} height={18} viewBox="0 0 12 18" accessible={false}>
          <Path d="m3 6 3-3 3 3M3 12l3 3 3-3" fill="none" stroke={theme.textSecondary} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </Svg> : <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={18} tintColor={theme.textSecondary} />}
      </View>
    </Pressable>;
  }
  const options = menu === 'date' ? dateOptions : menu === 'tag' ? tagOptions : contentOptions;
  const activeOption = menu === 'date' ? draft.dateRange : menu === 'tag' ? draft.tagRange : draft.contentRange;
  const firstDay = new Date(calendarMonth.year, calendarMonth.month, 1);
  const dayCount = new Date(calendarMonth.year, calendarMonth.month + 1, 0).getDate();
  const calendarCells = Array.from({ length: (firstDay.getDay() + 6) % 7 + dayCount }, (_, index) => index - (firstDay.getDay() + 6) % 7 + 1);

  return <Modal transparent visible animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={cancelOrBack}>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      onLayout={(event) => setOverlayHeight(event.nativeEvent.layout.height)}>
      <Pressable accessibilityLabel="取消搜索筛选" accessibilityRole="button" onPress={cancelOrBack} style={[StyleSheet.absoluteFill, styles.scrim]} />
      <View style={[styles.sheet, { backgroundColor: theme.surface, paddingBottom: Math.max(insets.bottom, 12), minHeight: Math.min(264, availableSheetHeight), maxHeight: availableSheetHeight }, page !== 'filters' && { height: Math.min(544, availableSheetHeight) }]}>
        <View style={[styles.sheetHeader, { borderBottomColor: theme.border }]}>
          <Pressable accessibilityLabel={page === 'filters' ? '取消筛选修改' : '取消选择'} accessibilityRole="button" onPress={cancelOrBack} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <SymbolView name={page === 'filters' ? { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' } : { ios: 'xmark', android: 'close', web: 'close' }} size={24} tintColor={theme.text} />
          </Pressable>
          <ThemedText style={styles.title}>{page === 'tags' ? '选择标签' : page === 'dates' ? '选择日期' : '筛选'}</ThemedText>
          <View style={{ flex: 1 }} />
          {page === 'filters' && hasSearchFilters(draft) && <Pressable accessibilityLabel="重置筛选草稿" accessibilityRole="button"
            onPress={() => { setDraft(emptySearchFilters()); setError(undefined); }} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'arrow.counterclockwise', android: 'restart_alt', web: 'restart_alt' }} size={24} tintColor={theme.textSecondary} />
          </Pressable>}
          <Pressable accessibilityLabel={page === 'filters' ? '确定筛选' : '确定选择'} accessibilityRole="button" onPress={confirm} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={26} tintColor={theme.accent} />
          </Pressable>
        </View>
        {page === 'filters' ? <ScrollView style={styles.filterScroll} contentContainerStyle={styles.filterRows} keyboardShouldPersistTaps="handled">
          {rangeRow('日期范围', dateOptions.find((option) => option.value === draft.dateRange)!.label, () => openMenu('date'), 'date')}
          {draft.dateRange === 'custom' && <>
            {rangeRow('开始日期', draft.startDate, () => openDates('start'))}
            {rangeRow('结束日期', draft.endDate, () => openDates('end'))}
          </>}
          {rangeRow('标签范围', tagOptions.find((option) => option.value === draft.tagRange)!.label, () => openMenu('tag'), 'tag')}
          {(draft.tagRange === 'include' || draft.tagRange === 'exclude') && rangeRow('指定标签', draft.tags.length > 0 ? draft.tags.join('、') : '无', () => { setSelectedTags([...draft.tags]); setTagQuery(''); setError(undefined); setPage('tags'); })}
          {rangeRow('内容范围', contentOptions.find((option) => option.value === draft.contentRange)!.label, () => openMenu('content'), 'content')}
        </ScrollView> : page === 'tags' ? <>
          <View style={[styles.tagSearch, { backgroundColor: theme.backgroundElement }]}>
            <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={20} tintColor={theme.textSecondary} />
            <TextInput accessibilityLabel="搜索筛选标签" placeholder="搜索标签" placeholderTextColor={theme.textSecondary} value={tagQuery} onChangeText={setTagQuery}
              style={[styles.tagInput, { color: theme.text }]} selectionColor={theme.accent} returnKeyType="search" onSubmitEditing={Keyboard.dismiss} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.tagList}>
            {availableTags.filter((tag) => tag.toLocaleLowerCase().includes(tagQuery.trim().toLocaleLowerCase())).map((tag) => {
              const selected = selectedTags.includes(tag);
              return <Pressable key={tag} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`选择标签 ${tag}`}
                onPress={() => { setSelectedTags((current) => selected ? current.filter((name) => name !== tag) : [...current, tag]); setError(undefined); }} style={({ pressed }) => [styles.tagRow, pressed && styles.pressed]}>
                <ThemedText style={styles.tagName}>{tag}</ThemedText>
                <View style={[styles.checkbox, { borderColor: theme.accent, backgroundColor: selected ? theme.accent : 'transparent' }]}>
                  {selected && <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={14} tintColor={theme.onAccent} />}
                </View>
              </Pressable>;
            })}
            {!availableTags.some((tag) => tag.toLocaleLowerCase().includes(tagQuery.trim().toLocaleLowerCase())) && <ThemedText style={styles.empty} themeColor="textSecondary">{availableTags.length === 0 ? '当前分区暂无标签' : '没有匹配的标签'}</ThemedText>}
          </ScrollView>
        </> : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.calendarContent}>
          <View style={styles.endpointRow}>
            {(['start', 'end'] as const).map((endpoint) => <Pressable key={endpoint} accessibilityRole="button" accessibilityLabel={endpoint === 'start' ? '选择开始日期' : '选择结束日期'} accessibilityState={{ selected: dateEndpoint === endpoint }}
              onPress={() => { setDateEndpoint(endpoint); setError(undefined); }} style={({ pressed }) => [styles.endpoint, { backgroundColor: dateEndpoint === endpoint ? theme.accentMuted : theme.backgroundElement }, pressed && styles.pressed]}>
              <ThemedText style={styles.endpointLabel} themeColor="textSecondary">{endpoint === 'start' ? '开始日期' : '结束日期'}</ThemedText>
              <ThemedText style={{ color: dateEndpoint === endpoint ? theme.accent : theme.text }}>{endpoint === 'start' ? dateStart : dateEnd}</ThemedText>
            </Pressable>)}
          </View>
          <View style={styles.monthHeader}>
            <Pressable accessibilityLabel="日期上个月" accessibilityRole="button" onPress={() => shiftCalendar(-1)} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }} size={22} tintColor={theme.text} />
            </Pressable>
            <ThemedText>{calendarMonth.year} 年 {calendarMonth.month + 1} 月</ThemedText>
            <Pressable accessibilityLabel="日期下个月" accessibilityRole="button" onPress={() => shiftCalendar(1)} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={22} tintColor={theme.text} />
            </Pressable>
          </View>
          <View style={styles.calendarGrid}>
            {['一', '二', '三', '四', '五', '六', '日'].map((day) => <ThemedText key={day} style={styles.weekday} themeColor="textSecondary">{day}</ThemedText>)}
            {calendarCells.map((day, index) => {
              if (day < 1) return <View key={`blank-${index}`} style={styles.dayCell} />;
              const dateLabel = localDateLabel(new Date(calendarMonth.year, calendarMonth.month, day));
              const selected = dateLabel === (dateEndpoint === 'start' ? dateStart : dateEnd);
              const inRange = dateStart <= dateLabel && dateLabel <= dateEnd;
              return <Pressable key={day} accessibilityRole="button" accessibilityLabel={`日期 ${dateLabel}`} accessibilityState={{ selected }} hitSlop={2}
                onPress={() => { if (dateEndpoint === 'start') { setDateStart(dateLabel); setDateEndpoint('end'); } else setDateEnd(dateLabel); setError(undefined); }}
                style={({ pressed }) => [styles.dayCell, { backgroundColor: selected ? theme.accent : inRange ? theme.accentMuted : 'transparent' }, pressed && styles.pressed]}>
                <ThemedText style={{ color: selected ? theme.onAccent : theme.text }}>{day}</ThemedText>
              </Pressable>;
            })}
          </View>
          <TextInput accessibilityLabel={dateEndpoint === 'start' ? '开始日期，格式年-月-日' : '结束日期，格式年-月-日'}
            value={dateEndpoint === 'start' ? dateStart : dateEnd} onChangeText={dateEndpoint === 'start' ? setDateStart : setDateEnd}
            placeholder="YYYY-MM-DD" placeholderTextColor={theme.textSecondary} maxLength={10} keyboardType="numbers-and-punctuation"
            style={[styles.dateInput, { borderColor: theme.border, color: theme.text }]} />
        </ScrollView>}
        {error && <ThemedText accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.error, { color: theme.danger }]}>{error}</ThemedText>}
        {menu && <>
          <Pressable accessibilityLabel="关闭筛选选项" accessibilityRole="button" onPress={() => setMenu(undefined)} style={StyleSheet.absoluteFill} />
          <View style={[styles.menu, { backgroundColor: theme.backgroundElement, top: Math.max(56, menuAnchor + 56 - (options.length - 1) * 48) }]}>
            {options.map((option) => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: activeOption === option.value }} accessibilityLabel={option.label}
              onPress={() => chooseOption(option.value)} style={({ pressed }) => [styles.menuOption, pressed && styles.pressed]}>
              <ThemedText style={[styles.optionLabel, activeOption === option.value && { color: theme.accent }]}>{option.label}</ThemedText>
              {activeOption === option.value && <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.accent} />}
            </Pressable>)}
          </View>
        </>}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  scrim: { backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { width: '100%', maxWidth: 800, alignSelf: 'center', borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  sheetHeader: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8 },
  title: { position: 'absolute', left: 96, right: 96, textAlign: 'center', fontSize: 17, fontWeight: '500' },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  filterScroll: { flexGrow: 0 },
  filterRows: { paddingHorizontal: 20, paddingVertical: 8 },
  rangeRow: { minHeight: 54, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  rowLabel: { fontSize: 16, fontWeight: '400', flexShrink: 0 },
  rowValue: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  valueLabel: { fontSize: 15, fontWeight: '400', flexShrink: 1 },
  menu: { position: 'absolute', right: 16, width: 204, borderRadius: 10, paddingVertical: 4, elevation: 6, boxShadow: '0 4px 20px rgba(0,0,0,0.16)' },
  menuOption: { minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  optionLabel: { fontSize: 16, fontWeight: '400', flexShrink: 1 },
  tagSearch: { margin: 16, borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  tagInput: { flex: 1, minHeight: 48, fontSize: 16, paddingHorizontal: 8 },
  tagList: { paddingHorizontal: 20, paddingBottom: 16 },
  tagRow: { minHeight: 48, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 16 },
  checkbox: { width: 20, height: 20, borderWidth: 1.5, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tagName: { flex: 1, marginLeft: 32, fontWeight: '400' },
  empty: { textAlign: 'center', paddingVertical: 32 },
  error: { paddingHorizontal: 20, paddingVertical: 8, fontSize: 14, fontWeight: '400' },
  calendarContent: { padding: 16, gap: 12 },
  endpointRow: { flexDirection: 'row', gap: 12 },
  endpoint: { flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10, padding: 8 },
  endpointLabel: { fontSize: 13, fontWeight: '400' },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 13, paddingVertical: 8 },
  dayCell: { width: `${100 / 7}%`, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  dateInput: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16 },
  pressed: { opacity: 0.6 },
});
