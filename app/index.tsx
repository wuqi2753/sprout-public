import { ServerConnectionForm } from '@/components/server-connection-form';
import { getServerConnectionConfig } from '@/storage/server-connection';
// REQ-023: docs/stories/v0.2.0/REQ-023-refine-core-screen-visuals.md
import { Image } from 'expo-image';
import { BlurTargetView, BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  BackHandler,
  Keyboard,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  type GestureResponderEvent,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useMentions, type PatternsConfig } from 'react-native-controlled-mentions';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';

import { SwipeSidebar } from '@/components/swipe-sidebar';
import { ExploreFilterPanel, type TagCount } from '@/components/explore-filter-panel';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { Pressable } from '@/components/haptic-pressable';
import { MemoSyncStatus } from '@/components/memo-sync-status';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useServerConnectionStatus } from '@/hooks/use-server-connection';
import { formatMemoTime } from '@/memos';
import { addMemo, deleteMemo, getMemos } from '@/storage/memos';
import type { Memo } from '@/types/memo';
import { syncMemoOutbox } from '@/sync/memo-outbox';
import { createUuid } from '@/sync/uuid';

const now = new Date();
type TextSelection = { start: number; end: number };

function findTagDraft(content: string, cursorPosition: number) {
  const contentBeforeCursor = content.slice(0, cursorPosition);
  const match = contentBeforeCursor.match(/(^|\s)#([^\s#]*)$/);
  if (!match) return null;

  return {
    query: match[2],
    start: contentBeforeCursor.length - match[2].length - 1,
    end: cursorPosition,
  };
}

function MemoContent({ content, numberOfLines }: { content: string; numberOfLines?: number }) {
  const theme = useTheme();
  const memoSegments = content.split(/(#[^\s#]*)/g);

  return (
    <View
      style={[
        styles.memoContentFlow,
        numberOfLines ? { maxHeight: numberOfLines * 24, overflow: 'hidden' } : undefined,
      ]}>
      {memoSegments.flatMap((segment, index) =>
        segment.startsWith('#') ? (
          <View
            key={`${index}-${segment}`}
            style={[styles.inlineTagPill, { backgroundColor: theme.tagBackground }]}>
            <ThemedText style={[styles.inlineTag, { color: theme.tag }]}>{segment}</ThemedText>
          </View>
        ) : segment
            .split(/([\u4e00-\u9fff]|[^\s\u4e00-\u9fff]+\s*)/g)
            .filter(Boolean)
            .map((textSegment, textIndex) => (
              <ThemedText key={`${index}-${textIndex}-${textSegment}`} style={styles.memoContent}>
                {textSegment}
              </ThemedText>
            )),
      )}
    </View>
  );
}

function MemoImages({ imageUris, onOpen }: { imageUris: string[]; onOpen: (index: number) => void }) {
  if (imageUris.length === 0) return null;
  if (imageUris.length === 1) {
    return (
      <Pressable
        accessibilityLabel="全屏查看图片"
        accessibilityRole="button"
        onPress={() => onOpen(0)}
        style={({ pressed }) => [styles.memoImage, pressed && styles.pressed]}>
        <Image contentFit="cover" source={{ uri: imageUris[0] }} style={styles.memoImageContent} />
      </Pressable>
    );
  }

  return (
    <View style={styles.memoImageGrid}>
      {imageUris.map((imageUri, index) => (
        <Pressable
          accessibilityLabel={`全屏查看第 ${index + 1} 张图片，共 ${imageUris.length} 张`}
          accessibilityRole="button"
          key={`${imageUri}-${index}`}
          onPress={() => onOpen(index)}
          style={({ pressed }) => [styles.memoGridImage, pressed && styles.pressed]}>
          <Image contentFit="cover" source={{ uri: imageUri }} style={styles.memoImageContent} />
        </Pressable>
      ))}
    </View>
  );
}

function shiftMonth(year: number, month: number, offset: number) {
  const shiftedDate = new Date(year, month + offset, 1);
  return { year: shiftedDate.getFullYear(), month: shiftedDate.getMonth() };
}

function IconButton({
  accessibilityLabel,
  alignIconStart = false,
  icon,
  iconSource,
  onPress,
  selected = false,
  tintColor,
  buttonWidth = 48,
  iconSize = 20,
  horizontalHitSlop = 8,
  disabled = false,
  iconSourceSize = 24,
}: {
  accessibilityLabel: string;
  alignIconStart?: boolean;
  icon: Parameters<typeof SymbolView>[0]['name'];
  iconSource?: number;
  onPress: () => void;
  selected?: boolean;
  tintColor?: string;
  buttonWidth?: number;
  iconSize?: number;
  horizontalHitSlop?: number;
  disabled?: boolean;
  iconSourceSize?: number;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={{ left: horizontalHitSlop, right: horizontalHitSlop, top: 0, bottom: 0 }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { width: buttonWidth },
        alignIconStart && styles.iconButtonStart,
        selected && { backgroundColor: theme.accentMuted },
        pressed && styles.pressed,
      ]}>
      {!selected && iconSource ? (
        <Image
          contentFit="contain"
          source={iconSource}
          style={{ width: iconSourceSize, height: iconSourceSize }}
          tintColor={tintColor ?? theme.textSecondary}
        />
      ) : (
        <SymbolView
          name={icon}
          size={iconSize}
          style={alignIconStart ? styles.iconOpticalStart : undefined}
          tintColor={selected ? theme.accent : (tintColor ?? theme.textSecondary)}
        />
      )}
    </Pressable>
  );
}

// REQ-016: docs/stories/v0.2.0/REQ-016-server-connection-form.md
export default function HomeEntry() {
  const [entry, setEntry] = useState<'loading' | 'welcome' | 'capture'>('loading');
  const [configReadError, setConfigReadError] = useState(false);
  useEffect(() => {
    let active = true;
    getServerConnectionConfig().then((config) => {
      if (active) setEntry(config ? 'capture' : 'welcome');
    }).catch(() => {
      if (active) { setConfigReadError(true); setEntry('welcome'); }
    });
    return () => { active = false; };
  }, []);
  if (entry === 'loading') return null;
  if (entry === 'capture') return <HomeScreen />;
  return <>
    <ServerConnectionForm onContinue={() => setEntry('capture')} />
    <FeedbackDialog visible={configReadError} title="无法读取服务器配置"
      message="请重新填写连接配置，或先在本地记录。" onDismiss={() => setConfigReadError(false)} />
  </>;
}

function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connectionStatus = useServerConnectionStatus();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const usesCompactComposer = windowHeight <= 500;
  const composerRef = useRef<TextInput>(null);
  const composerBlurTarget = useRef<View>(null);
  const [content, setContent] = useState('');
  const [imageUris, setImageUris] = useState<string[]>([]);
  const [composerSelection, setComposerSelection] = useState<TextSelection>({ start: 0, end: 0 });
  const [composerOpen, setComposerOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [savingMemo, setSavingMemo] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string>();
  const refreshingRef = useRef(false);
  const refreshAndSyncRef = useRef<() => void>(() => {});
  const scrollOffsetY = useRef(0);
  const refreshStartedAtTop = useRef(false);
  const pullOffset = useRef(new Animated.Value(0)).current;
  const [imagePreview, setImagePreview] = useState<{ imageUris: string[]; index: number }>();
  const [openMemoMenuId, setOpenMemoMenuId] = useState<string | null>(null);
  const [memoMenuPosition, setMemoMenuPosition] = useState({ left: 0, top: 0 });
  const [expandedMemoIds, setExpandedMemoIds] = useState<string[]>([]);
  const [searchVisible, setSearchVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(now.getFullYear());
  const [visibleMonth, setVisibleMonth] = useState(now.getMonth());
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const scrollGesture = useMemo(() => Gesture.Native().enabled(Platform.OS === 'android'), []);
  const refreshGesture = useMemo(
    () => Gesture.Pan()
      .enabled(Platform.OS === 'android')
      .activeOffsetY(8)
      .failOffsetY(-8)
      .simultaneousWithExternalGesture(scrollGesture)
      .runOnJS(true)
      .onBegin(() => {
        refreshStartedAtTop.current = scrollOffsetY.current <= 0 && !refreshingRef.current;
      })
      .onUpdate((event) => {
        if (refreshStartedAtTop.current) {
          pullOffset.setValue(Math.min(Math.max(event.translationY, 0) * 0.6, 120));
        }
      })
      .onEnd((event) => {
        if (refreshStartedAtTop.current && event.translationY >= 70) refreshAndSyncRef.current();
        else Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
      }),
    [pullOffset, scrollGesture],
  );
  const composerPatterns = useMemo<PatternsConfig>(
    () => ({
      tag: {
        pattern: /(#[^\s#]*)/g,
        textStyle: { color: theme.tag, fontWeight: '400' },
      },
    }),
    [theme.tag],
  );
  const { textInputProps: composerTextInputProps } = useMentions({
    value: content,
    onChange: setContent,
    onSelectionChange: setComposerSelection,
    patternsConfig: composerPatterns,
  });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      getMemos()
        .then((storedMemos) => {
          if (active) setMemos(storedMemos);
        })
        .catch((error) => showStorageError('无法读取记录', error));
      return () => {
        active = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (activeDay === null && activeTag === null) return false;

        setActiveDay(null);
        setActiveTag(null);
        setVisibleYear(now.getFullYear());
        setVisibleMonth(now.getMonth());
        return true;
      });

      return () => backSubscription.remove();
    }, [activeDay, activeTag]),
  );

  const tags = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>();
    memos.forEach((memo) => memo.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name));
  }, [memos]);

  const recordDays = useMemo(
    () =>
      new Set(
        memos
          .filter(
            (memo) =>
              memo.createdOn.getFullYear() === visibleYear && memo.createdOn.getMonth() === visibleMonth,
          )
          .map((memo) => memo.createdOn.getDate()),
      ),
    [memos, visibleMonth, visibleYear],
  );

  const filteredMemos = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return memos.filter((memo) => {
      const matchesQuery = !normalizedQuery || memo.content.toLocaleLowerCase().includes(normalizedQuery);
      const matchesDay =
        activeDay === null ||
        (memo.createdOn.getFullYear() === visibleYear &&
          memo.createdOn.getMonth() === visibleMonth &&
          memo.createdOn.getDate() === activeDay);
      const matchesTag = activeTag === null || memo.tags.includes(activeTag);
      return matchesQuery && matchesDay && matchesTag;
    });
  }, [activeDay, activeTag, memos, query, visibleMonth, visibleYear]);

  const canSave = content.trim().length > 0 || imageUris.length > 0;
  const hasActiveConditions = query.trim().length > 0 || activeDay !== null || activeTag !== null;
  const tagDraft = findTagDraft(content, composerSelection.start);
  const suggestedTags = tagDraft
    ? tags
        .filter(({ name }) => name.toLocaleLowerCase().includes(tagDraft.query.toLocaleLowerCase()))
        .slice(0, 5)
    : [];

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!savingMemo) {
        Keyboard.dismiss();
        setContent('');
        setImageUris([]);
        setComposerSelection({ start: 0, end: 0 });
        setComposerOpen(false);
      }
      return true;
    });
    return () => subscription.remove();
  }, [composerOpen, savingMemo]);

  function showStorageError(title: string, error: unknown) {
    console.error(title, error);
    if (Platform.OS === 'web') window.alert(`${title}，请稍后重试。`);
    else Alert.alert(title, '请稍后重试。');
  }

  async function saveMemo() {
    const normalizedContent = content.trim();
    if ((!normalizedContent && imageUris.length === 0) || savingMemo) return;

    const savedAt = new Date();
    setSavingMemo(true);
    try {
      await addMemo({
        id: createUuid(),
        content: normalizedContent,
        createdOn: savedAt,
        imageUris,
      });
      setContent('');
      setImageUris([]);
      setComposerSelection({ start: 0, end: 0 });
      Keyboard.dismiss();
      setComposerOpen(false);
    } catch (error) {
      showStorageError('无法保存记录', error);
      return;
    } finally {
      setSavingMemo(false);
    }
    try {
      setMemos(await getMemos());
    } catch (error) {
      showStorageError('记录已保存，但无法刷新列表', error);
    }
  }

  async function refreshAndSync() {
    if (refreshingRef.current) return;
    if (connectionStatus !== 'connected') {
      setSyncFeedback('请先连接服务器');
      if (Platform.OS === 'android') {
        Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
      }
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    if (Platform.OS === 'android') {
      pullOffset.stopAnimation();
      pullOffset.setValue(80);
    }
    try {
      await syncMemoOutbox();
      setMemos(await getMemos());
    } catch (error) {
      console.error('Unable to synchronize memos', error);
      try {
        setMemos(await getMemos());
      } catch (storageError) {
        showStorageError('无法刷新记录', storageError);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      if (Platform.OS === 'android') {
        Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
      }
    }
  }
  refreshAndSyncRef.current = refreshAndSync;

  async function chooseMemoImage() {
    const remainingImageCount = 9 - imageUris.length;
    if (remainingImageCount === 0) {
      if (Platform.OS === 'web') window.alert('每条记录最多添加 9 张图片。');
      else Alert.alert('图片数量已达上限', '每条记录最多添加 9 张图片。');
      return;
    }

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        if (Platform.OS === 'web') window.alert('需要照片权限：允许 Sprout 访问照片后，才能为记录添加图片。');
        else Alert.alert('需要照片权限', '允许 Sprout 访问照片后，才能为记录添加图片。');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: remainingImageCount,
        allowsEditing: false,
        quality: 0.85,
      });
      if (!result.canceled) {
        const selectedImageUris = await Promise.all(
          result.assets.map(async ({ uri, fileName }) => {
            if (Platform.OS === 'web' || uri.startsWith('file://')) return uri;

            const cacheDirectory = new Directory(Paths.cache, 'memo-images');
            if (!cacheDirectory.exists) cacheDirectory.create({ intermediates: true });
            const imageExtension = fileName?.split('.').pop() ?? 'jpg';
            const cachedImage = new File(cacheDirectory, `${Date.now()}-${Math.random().toString(36).slice(2)}.${imageExtension}`);
            await new File(uri).copy(cachedImage);
            return cachedImage.uri;
          }),
        );
        setImageUris((currentImageUris) => [...currentImageUris, ...selectedImageUris].slice(0, 9));
      }
    } catch (error) {
      console.error('Failed to select memo image', error);
      if (Platform.OS === 'web') window.alert('无法选择图片，请稍后重试。');
      else Alert.alert('无法选择图片', '请稍后重试。');
    }
  }

  function addTagPrompt() {
    const insertion = `${composerSelection.start > 0 && !/\s/.test(content[composerSelection.start - 1]) ? ' ' : ''}#`;
    const nextContent = `${content.slice(0, composerSelection.start)}${insertion}${content.slice(composerSelection.end)}`;
    const nextCursorPosition = composerSelection.start + insertion.length;
    const nextSelection = { start: nextCursorPosition, end: nextCursorPosition };
    setContent(nextContent);
    composerRef.current?.focus();
    requestAnimationFrame(() => {
      setComposerSelection(nextSelection);
      composerRef.current?.setNativeProps({ selection: nextSelection });
    });
  }

  function selectSuggestedTag(tag: string) {
    if (!tagDraft) return;
    const insertion = `#${tag} `;
    const nextContent = `${content.slice(0, tagDraft.start)}${insertion}${content.slice(tagDraft.end)}`;
    const nextCursorPosition = tagDraft.start + insertion.length;
    const nextSelection = { start: nextCursorPosition, end: nextCursorPosition };
    setContent(nextContent);
    composerRef.current?.focus();
    requestAnimationFrame(() => {
      setComposerSelection(nextSelection);
      composerRef.current?.setNativeProps({ selection: nextSelection });
    });
  }

  function closeSearch() {
    Keyboard.dismiss();
    setQuery('');
    setSearchVisible(false);
  }

  function openComposer() {
    setComposerOpen(true);
  }

  function closeComposer() {
    if (savingMemo) return;
    Keyboard.dismiss();
    setContent('');
    setImageUris([]);
    setComposerSelection({ start: 0, end: 0 });
    setComposerOpen(false);
  }

  function toggleMemoMenu(memoId: string, event: GestureResponderEvent) {
    if (openMemoMenuId === memoId) {
      setOpenMemoMenuId(null);
      return;
    }

    const menuWidth = 132;
    const screenMargin = 12;
    setMemoMenuPosition({
      left: Math.min(windowWidth - menuWidth - screenMargin, Math.max(screenMargin, event.nativeEvent.pageX - menuWidth)),
      top: Math.min(windowHeight - 108, event.nativeEvent.pageY + 18),
    });
    setOpenMemoMenuId(memoId);
  }

  function openFilterPanel() {
    Keyboard.dismiss();
    if (composerOpen) closeComposer();
    setFilterOpen(true);
  }

  function openServerConnection() {
    setFilterOpen(false);
    router.push('/server-connection');
  }

  function selectTagAndCloseFilter(tag: string) {
    setActiveTag((currentTag) => (currentTag === tag ? null : tag));
    setFilterOpen(false);
  }

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

  return (
    <SwipeSidebar
      open={filterOpen}
      gesturesEnabled={windowWidth < 768 && !composerOpen}
      width={windowWidth * 0.8}
      onOpenChange={setFilterOpen}
      onEdgeBack={() => {
        setActiveDay(null);
        setActiveTag(null);
        setVisibleYear(now.getFullYear());
        setVisibleMonth(now.getMonth());
      }}
      sidebar={
            <SafeAreaView
              edges={['top', 'bottom']}
              style={[styles.drawerSafeArea, { backgroundColor: theme.surface, width: '100%' }]}>
              <ExploreFilterPanel
                activeDay={activeDay}
                activeTag={activeTag}
                connectionStatus={connectionStatus}
                month={visibleMonth}
                onAddServer={openServerConnection}
                onChangeMonth={changeMonth}
                onSelectDay={(day) => setActiveDay((currentDay) => (currentDay === day ? null : day))}
                onSelectTag={selectTagAndCloseFilter}
                recordDays={recordDays}
                tags={tags}
                width="100%"
                year={visibleYear}
              />
            </SafeAreaView>
      }>
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <BlurTargetView ref={composerBlurTarget} style={styles.screen}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.screen}>
          <View style={styles.contentColumn}>
            <View style={styles.header}>
              <View style={styles.brandGroup}>
                <Pressable
                  accessibilityLabel="打开筛选侧栏"
                  accessibilityRole="button"
                  accessibilityState={{ expanded: filterOpen }}
                  hitSlop={8}
                  onPress={openFilterPanel}
                  style={({ pressed }) => [styles.sidebarButton, pressed && styles.pressed]}>
                  <Image
                    contentFit="contain"
                    source={require('@/assets/icons/sidebar.svg')}
                    style={styles.sidebarIcon}
                  />
                </Pressable>
                <ThemedText
                  accessibilityLabel={activeTag ?? 'Sprout'}
                  numberOfLines={1}
                  style={[styles.wordmark, activeTag !== null && styles.tagViewTitle]}>
                  {activeTag ?? 'Sprout\u00A0'}
                </ThemedText>
              </View>
              <View style={styles.headerActions}>
                <IconButton
                  accessibilityLabel={searchVisible ? '关闭搜索' : '搜索记录'}
                  icon={{
                    ios: searchVisible ? 'xmark' : 'magnifyingglass',
                    android: searchVisible ? 'close' : 'search',
                    web: searchVisible ? 'close' : 'search',
                  }}
                  iconSource={require('@/assets/icons/search.svg')}
                  onPress={() => (searchVisible ? closeSearch() : setSearchVisible(true))}
                  selected={searchVisible}
                />
              </View>
            </View>

            {searchVisible && (
              <View style={[styles.searchField, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
                <SymbolView
                  name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
                  size={18}
                  tintColor={theme.textSecondary}
                />
                <TextInput
                  accessibilityLabel="搜索记录"
                  autoFocus
                  onChangeText={setQuery}
                  placeholder="搜索内容或标签"
                  placeholderTextColor={theme.textSecondary}
                  returnKeyType="search"
                  selectionColor={theme.accent}
                  style={[styles.searchInput, { color: theme.text }]}
                  value={query}
                />
              </View>
            )}
          </View>
          <GestureDetector gesture={refreshGesture}>
          <View style={styles.refreshArea}>
          <Animated.View
              pointerEvents="none"
              style={[
                styles.refreshIndicator,
                { opacity: pullOffset.interpolate({ inputRange: [20, 56], outputRange: [0, 1], extrapolate: 'clamp' }) },
              ]}>
              <View style={[styles.refreshIndicatorBadge, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <ActivityIndicator color={theme.accent} size="small" />
              </View>
            </Animated.View>
          <GestureDetector gesture={scrollGesture}>
          <ScrollView
            style={styles.scrollView}
            disableScrollViewPanResponder={Platform.OS === 'android'}
            contentContainerStyle={styles.scrollContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => { scrollOffsetY.current = event.nativeEvent.contentOffset.y; }}
            scrollEventThrottle={16}
            refreshControl={Platform.OS === 'android' ? undefined : <RefreshControl refreshing={refreshing} onRefresh={refreshAndSync} />}>
          <Animated.View style={[styles.contentColumn, { transform: [{ translateY: pullOffset }] }]}>
            {(activeDay !== null || activeTag !== null) && (
              <View style={styles.activeFilterRow}>
                <ThemedText style={styles.activeFilterText} themeColor="textSecondary">
                  {[
                    activeDay !== null ? `${visibleMonth + 1} 月 ${activeDay} 日` : null,
                    activeTag !== null ? `#${activeTag}` : null,
                  ]
                    .filter(Boolean)
                    .join('  ')}
                </ThemedText>
                <Pressable
                  accessibilityLabel="清除全部筛选"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={clearFilters}
                  style={({ pressed }) => [styles.clearFilterButton, pressed && styles.pressed]}>
                  <ThemedText style={[styles.clearFilterLabel, { color: theme.accent }]}>清除</ThemedText>
                </Pressable>
              </View>
            )}

            {filteredMemos.length > 0 ? (
              <View style={styles.memoList}>
                {filteredMemos.map((memo) => {
                  const isExpanded = expandedMemoIds.includes(memo.id);
                  const canExpand = memo.content.length > 90;
                  return (
                  <View key={memo.id} style={[styles.memo, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                    <View style={styles.memoHeader}>
                      <View style={styles.memoMetadata}>
                        <ThemedText style={styles.memoTime} themeColor="textSecondary">
                          {formatMemoTime(memo.createdOn)}
                        </ThemedText>
                        <MemoSyncStatus synced={memo.synced} />
                      </View>
                      <Pressable
                        accessibilityLabel={`打开${formatMemoTime(memo.createdOn)}记录的操作菜单`}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: openMemoMenuId === memo.id }}
                        hitSlop={8}
                        onPress={(event) => toggleMemoMenu(memo.id, event)}
                        style={({ pressed }) => [styles.memoMenuButton, pressed && styles.pressed]}>
                        <SymbolView name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }} size={20} tintColor={theme.textSecondary} />
                      </Pressable>
                    </View>
                    {memo.content.length > 0 && <MemoContent content={memo.content} numberOfLines={canExpand && !isExpanded ? 3 : undefined} />}
                    <MemoImages
                      imageUris={memo.imageUris}
                      onOpen={(index) => setImagePreview({ imageUris: memo.imageUris, index })}
                    />
                    {canExpand && (
                      <Pressable
                        accessibilityLabel={isExpanded ? '收起记录正文' : '展开记录正文'}
                        accessibilityRole="button"
                        onPress={() => setExpandedMemoIds((currentIds) => isExpanded ? currentIds.filter((id) => id !== memo.id) : [...currentIds, memo.id])}
                        style={({ pressed }) => [styles.expandButton, pressed && styles.pressed]}>
                        <ThemedText style={[styles.expandLabel, { color: theme.accent }]}>{isExpanded ? '收起' : '展开'}</ThemedText>
                      </Pressable>
                    )}
                  </View>
                  );
                })}
              </View>
            ) : (
              <View style={[styles.emptyState, { borderColor: theme.border }]}>
                <ThemedText style={styles.emptyTitle}>{hasActiveConditions ? '没有找到记录' : '记下此刻的想法'}</ThemedText>
                <ThemedText style={styles.emptyBody} themeColor="textSecondary">
                  {hasActiveConditions ? '换个关键词，或者清除筛选再看看。' : '一句话也值得留下。'}
                </ThemedText>
                <Pressable
                  accessibilityRole="button"
                  onPress={hasActiveConditions ? () => { closeSearch(); clearFilters(); } : openComposer}
                  style={({ pressed }) => [
                    styles.clearButton,
                    { borderColor: theme.border },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText style={styles.clearLabel}>{hasActiveConditions ? '查看全部' : '开始记录'}</ThemedText>
                </Pressable>
              </View>
            )}
          </Animated.View>
          </ScrollView>
          </GestureDetector>
          </View>
          </GestureDetector>
        </KeyboardAvoidingView>
      </BlurTargetView>

      {!composerOpen && (
        <View style={[styles.bottomEntryContainer, { backgroundColor: theme.background }]}>
          <Pressable
            accessibilityLabel="点击开始记录"
            accessibilityRole="button"
            onPress={openComposer}
            style={({ pressed }) => [styles.bottomEntry, { backgroundColor: theme.surface, borderColor: theme.border }, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={23} tintColor={theme.accent} />
            <ThemedText style={styles.bottomEntryLabel} themeColor="textSecondary">记下此刻的想法…</ThemedText>
          </Pressable>
        </View>
      )}

      {composerOpen && (
        <View style={[styles.composerModal, { bottom: keyboardHeight }]}>
          <BlurView
            blurTarget={composerBlurTarget}
            blurMethod="dimezisBlurViewSdk31Plus"
            intensity={70}
            pointerEvents="none"
            style={styles.composerBlur}
            tint={theme.background === '#171815' ? 'dark' : 'light'}
          />
          <Pressable accessibilityLabel="关闭记录输入" accessibilityRole="button" onPress={closeComposer} style={styles.composerBackdrop} />
          <View style={[styles.composerSheet, imageUris.length > 0 && { height: 184 + Math.ceil(imageUris.length / 3) * 68 }, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            {suggestedTags.length > 0 && (
              <View
                accessibilityLabel="历史标签候选"
                style={[
                  styles.tagSuggestionPopup,
                  usesCompactComposer && styles.tagSuggestionPopupCompact,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ]}>
                {suggestedTags.map(({ name }, index) => (
                  <Pressable
                    accessibilityLabel={`选择标签 ${name}`}
                    accessibilityRole="button"
                    key={name}
                    onPress={() => selectSuggestedTag(name)}
                    style={({ pressed }) => [
                      styles.tagSuggestionRow,
                      usesCompactComposer && styles.tagSuggestionRowCompact,
                      index < suggestedTags.length - 1 && (usesCompactComposer
                        ? { borderRightColor: theme.border, borderRightWidth: StyleSheet.hairlineWidth }
                        : { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth }),
                      pressed && { backgroundColor: theme.backgroundSelected },
                    ]}>
                    <ThemedText style={styles.tagSuggestionLabel}># {name}</ThemedText>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={[styles.sheetHandle, { backgroundColor: theme.border }]} />
            <TextInput
              {...composerTextInputProps}
              ref={composerRef}
              accessibilityLabel="记录此刻的想法"
              autoFocus
              cursorColor={theme.accent}
              multiline
              onSubmitEditing={saveMemo}
              placeholder="现在的想法是..."
              placeholderTextColor={theme.textSecondary}
              selection={composerSelection}
              selectionColor={theme.accent}
              style={[styles.composerInput, { color: theme.text }]}
              textAlignVertical="top"
            />
            {imageUris.length > 0 && (
              <View style={styles.composerImageGrid}>
                {imageUris.map((imageUri, index) => (
                  <View key={`${imageUri}-${index}`} style={styles.composerImageItem}>
                    <Image contentFit="cover" source={{ uri: imageUri }} style={styles.composerImage} />
                    <Pressable
                      accessibilityLabel={`移除第 ${index + 1} 张待添加图片`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => setImageUris((currentImageUris) => currentImageUris.filter((_, imageIndex) => imageIndex !== index))}
                      style={({ pressed }) => [styles.removeImageButton, { backgroundColor: theme.backgroundSelected }, pressed && styles.pressed]}>
                      <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={16} tintColor={theme.text} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
            <View style={styles.composerActions}>
              <View style={styles.composerMediaActions}>
                <IconButton
                  accessibilityLabel="添加标签"
                  icon={{ ios: 'tag', android: 'tag', web: 'tag' }}
                  onPress={addTagPrompt}
                  tintColor={theme.text}
                  iconSize={18}
                  horizontalHitSlop={0}
                />
                <IconButton
                  accessibilityLabel={`添加图片，已选${imageUris.length}张，最多9张`}
                  disabled={imageUris.length >= 9}
                  icon={{ ios: 'photo', android: 'photo', web: 'photo' }}
                  iconSource={require('@/assets/icons/image-attachment.svg')}
                  onPress={chooseMemoImage}
                  tintColor={theme.text}
                  iconSize={18}
                  iconSourceSize={18}
                />
              </View>
              <Pressable
                accessibilityLabel="保存记录"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSave || savingMemo }}
                disabled={!canSave || savingMemo}
                hitSlop={{ top: 4, bottom: 4 }}
                onPress={saveMemo}
                style={({ pressed }) => [
                  styles.composerSendButton,
                  { backgroundColor: canSave && !savingMemo ? theme.accent : theme.backgroundSelected },
                  pressed && canSave && !savingMemo && styles.pressed,
                ]}>
                {savingMemo ? (
                  <ActivityIndicator color={theme.textSecondary} size="small" />
                ) : (
                  <SymbolView
                    name={{ ios: 'paperplane.fill', android: 'send', web: 'send' }}
                    size={24}
                    tintColor={canSave ? theme.onAccent : theme.textSecondary}
                  />
                )}
              </Pressable>
            </View>
          </View>
        </View>
      )}

      <Modal
        animationType="fade"
        onRequestClose={() => setOpenMemoMenuId(null)}
        statusBarTranslucent
        transparent
        visible={openMemoMenuId !== null}>
        <View style={styles.memoMenuModal}>
          <Pressable
            accessibilityLabel="关闭记录操作菜单"
            accessibilityRole="button"
            onPress={() => setOpenMemoMenuId(null)}
            style={StyleSheet.absoluteFill}
          />
          {openMemoMenuId !== null && (() => {
            const selectedMemo = memos.find((memo) => memo.id === openMemoMenuId);
            if (!selectedMemo) return null;
            return (
              <View
                style={[
                  styles.memoMenu,
                  memoMenuPosition,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ]}>
                <Pressable
                  accessibilityLabel="编辑记录"
                  accessibilityRole="button"
                  onPress={() => {
                    setOpenMemoMenuId(null);
                    router.push({ pathname: '/memo/[id]', params: { id: selectedMemo.id, content: selectedMemo.content } });
                  }}
                  style={({ pressed }) => [styles.memoMenuItem, pressed && styles.pressed]}>
                  <ThemedText style={styles.memoMenuLabel}>编辑</ThemedText>
                </Pressable>
                <Pressable
                  accessibilityLabel="删除记录"
                  accessibilityRole="button"
                  onPress={async () => {
                    try {
                      await deleteMemo(selectedMemo.id);
                      setMemos(await getMemos());
                      setOpenMemoMenuId(null);
                    } catch (error) {
                      showStorageError('无法删除记录', error);
                    }
                  }}
                  style={({ pressed }) => [styles.memoMenuItem, pressed && styles.pressed]}>
                  <ThemedText style={[styles.memoMenuLabel, { color: theme.danger }]}>删除</ThemedText>
                </Pressable>
              </View>
            );
          })()}
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setImagePreview(undefined)}
        statusBarTranslucent
        transparent
        visible={Boolean(imagePreview)}>
        {imagePreview && (
          <View style={styles.imagePreviewScreen}>
            <ScrollView
              contentOffset={{ x: imagePreview.index * windowWidth, y: 0 }}
              horizontal
              key={`${imagePreview.imageUris.join('|')}-${imagePreview.index}`}
              onMomentumScrollEnd={(event) => {
                const nextIndex = Math.round(event.nativeEvent.contentOffset.x / windowWidth);
                setImagePreview((currentPreview) =>
                  currentPreview ? { ...currentPreview, index: nextIndex } : undefined,
                );
              }}
              pagingEnabled
              showsHorizontalScrollIndicator={false}>
              {imagePreview.imageUris.map((imageUri, index) => (
                <View key={`${imageUri}-${index}`} style={[styles.imagePreviewPage, { width: windowWidth }]}>
                  <Image contentFit="contain" source={{ uri: imageUri }} style={styles.imagePreviewImage} />
                </View>
              ))}
            </ScrollView>
            {imagePreview.imageUris.length > 1 && (
              <ThemedText style={styles.imagePreviewCounter}>
                {imagePreview.index + 1} / {imagePreview.imageUris.length}
              </ThemedText>
            )}
            <Pressable
              accessibilityLabel="关闭图片预览"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setImagePreview(undefined)}
              style={({ pressed }) => [styles.imagePreviewClose, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={26} tintColor="#FFFFFF" />
            </Pressable>
          </View>
        )}
      </Modal>

      <FeedbackDialog
        onDismiss={() => setSyncFeedback(undefined)}
        title={syncFeedback ?? ''}
        visible={syncFeedback !== undefined}
      />
    </SafeAreaView>
    </SwipeSidebar>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  refreshArea: { flex: 1, width: '100%' },
  refreshIndicator: { position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' },
  refreshIndicatorBadge: { width: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', elevation: 2, shadowColor: '#000000', shadowOpacity: 0.08, shadowRadius: 6 },
  scrollView: { flex: 1, width: '100%' },
  scrollContent: { width: '100%', alignItems: 'center', paddingBottom: Spacing.four },
  contentColumn: {
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.three,
    boxSizing: 'border-box',
  },
  header: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Spacing.two,
  },
  brandGroup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  sidebarButton: { width: 48, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  sidebarIcon: { width: 24, height: 24 },
  headerIcon: { width: 24, height: 24 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  wordmark: {
    flexShrink: 1,
    fontFamily: 'Caveat_600SemiBold',
    fontSize: 24,
    lineHeight: 36,
  },
  tagViewTitle: { fontFamily: undefined, fontSize: 20, lineHeight: 28, fontWeight: '700' },
  iconButton: { width: 48, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  iconButtonStart: { alignItems: 'flex-start' },
  iconOpticalStart: { transform: [{ translateX: -3 }] },
  pressed: { opacity: 0.72 },
  searchField: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    marginBottom: Spacing.three,
  },
  searchInput: { flex: 1, fontSize: 16, lineHeight: 22, paddingVertical: 10 },
  composerModal: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end', alignItems: 'center', zIndex: 10 },
  composerBlur: { ...StyleSheet.absoluteFill, bottom: 184 },
  composerBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0, 0, 0, 0.18)' },
  composerSheet: { width: '100%', maxWidth: MaxContentWidth, maxHeight: '55%', height: 184, alignSelf: 'center', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: Spacing.two, paddingBottom: Spacing.four },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.two },
  composerInput: { flex: 1, minHeight: 72, fontSize: 16, lineHeight: 24, fontWeight: '400', padding: 0, paddingTop: 2, paddingHorizontal: 2 },
  tagSuggestionPopup: { position: 'absolute', zIndex: 3, left: Spacing.three, right: Spacing.three, maxWidth: MaxContentWidth - Spacing.six, alignSelf: 'center', bottom: 188, maxHeight: 220, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  tagSuggestionPopupCompact: { bottom: 8, height: 44, flexDirection: 'row' },
  tagSuggestionRow: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.three, paddingVertical: Spacing.one },
  tagSuggestionRowCompact: { flex: 1, minWidth: 0, paddingVertical: 0 },
  tagSuggestionLabel: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  composerActions: {
    flexShrink: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  composerMediaActions: { flexDirection: 'row', alignItems: 'center' },
  composerImageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: Spacing.one },
  composerImageItem: { position: 'relative', width: 64, height: 64, marginRight: 4, marginBottom: 4 },
  composerImage: { width: '100%', height: '100%', borderRadius: 8 },
  removeImageButton: { position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  composerSendButton: { width: 56, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  bottomEntryContainer: { width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: Spacing.two },
  bottomEntry: { minHeight: 56, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.three, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  bottomEntryLabel: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
  saveButton: {
    minHeight: 44,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: Spacing.three,
  },
  saveLabel: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  clearFilterButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  activeFilterRow: {
    minHeight: 32,
    marginBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  activeFilterText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  clearFilterLabel: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  memoList: { gap: 12 },
  memo: {
    position: 'relative',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingTop: 12,
    paddingBottom: Spacing.three,
    gap: 6,
  },
  memoHeader: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  memoMetadata: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  memoMenuButton: { width: 48, height: 48, marginVertical: -8, marginRight: -8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  memoMenuModal: { flex: 1 },
  memoMenu: { position: 'absolute', width: 132, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingVertical: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 5 },
  memoMenuItem: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  memoMenuLabel: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  memoTime: { flexShrink: 1, fontSize: 12, lineHeight: 18, fontWeight: '400' },
  memoContentFlow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 3 },
  memoContent: { flexShrink: 1, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  memoImage: { width: 120, height: 180, borderRadius: 6, marginTop: 10, overflow: 'hidden' },
  memoImageContent: { width: '100%', height: '100%' },
  memoImageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  memoGridImage: { width: 84, height: 84, borderRadius: 6, overflow: 'hidden' },
  imagePreviewScreen: { flex: 1, backgroundColor: '#000000' },
  imagePreviewPage: { height: '100%', alignItems: 'center', justifyContent: 'center' },
  imagePreviewImage: { width: '100%', height: '100%' },
  imagePreviewCounter: { position: 'absolute', top: 58, alignSelf: 'center', color: '#FFFFFF', fontSize: 14, lineHeight: 20 },
  imagePreviewClose: { position: 'absolute', top: 44, right: 18, width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: 'rgba(0, 0, 0, 0.42)' },
  inlineTagPill: { flexShrink: 0, marginHorizontal: 2, borderRadius: 6, paddingHorizontal: 4, paddingVertical: 1 },
  inlineTag: { fontSize: 12, lineHeight: 15, fontWeight: '500' },
  expandButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  expandLabel: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  emptyState: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
  },
  emptyTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
  emptyBody: { fontSize: 14, lineHeight: 21, marginTop: Spacing.one, textAlign: 'center' },
  clearButton: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.three,
  },
  clearLabel: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  drawerSafeArea: { height: '100%' },
});
