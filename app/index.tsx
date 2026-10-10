// REQ-023: docs/stories/v0.2.0/REQ-023-refine-core-screen-visuals.md
import { Image } from 'expo-image';
import { BlurTargetView, BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import Svg, { Path } from 'react-native-svg';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  BackHandler,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  type GestureResponderEvent,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useMentions, type PatternsConfig } from 'react-native-controlled-mentions';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';

import { SwipeSidebar } from '@/components/swipe-sidebar';
import { ZoomableImage } from '@/components/zoomable-image';
import { ExploreFilterPanel, type TagCount } from '@/components/explore-filter-panel';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { Pressable } from '@/components/haptic-pressable';
import { MemoSyncStatus } from '@/components/memo-sync-status';
import { ThemedText } from '@/components/themed-text';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useServerConnection } from '@/hooks/use-server-connection';
import { findTagDraft, formatMemoTime } from '@/memos';
import { addMemo, deleteMemo, getMemos, initializeWelcomeMemo, renameMemoFile, restoreMemo, setMemoHidden } from '@/storage/memos';
import type { Memo } from '@/types/memo';
import { getMemoSyncProgress, subscribeMemoSyncProgress, syncMemoOutbox } from '@/sync/memo-outbox';
import { createUuid } from '@/sync/uuid';
import { FileAttachmentCard } from '@/components/file-attachment-card';
import { FileTypeIcon } from '@/components/file-type-icon';
import { CaretTagSuggestions } from '@/components/caret-tag-suggestions';
import { CAPTURE_ENTRY_BOTTOM_GAP, CaptureBackdropFade } from '@/components/capture-backdrop-fade';
import { FileNameActions } from '@/components/file-name-actions';
import { chooseFileAttachments, discardImportedFile } from '@/storage/import-file';
import { useSharedFile } from '@/hooks/use-shared-file';
import type { FileAttachment } from '@/types/attachment';
import { openFileAttachment } from '@/storage/open-file';
import { hiddenMemoSession } from '@/auth/hidden-memo-session';
import { useHiddenMemoAccess } from '@/hooks/use-hidden-memo-access';
import { MemoSearchHeader, MemoSearchShortcuts, MemoSearchSummary, MemoRecentSearches } from '@/components/memo-search';
import { getSearchHistory, saveSearchHistory } from '@/storage/search-history';
import { addRecentSearch, type SearchPartition } from '@/storage/search-history-rules';
import { MemoSearchFiltersSheet } from '@/components/memo-search-filters';
import { emptySearchFilters, hasSearchFilters, matchesMemoSearch, sortSearchMemos, type MemoSearchFilters, type MemoSearchSort } from '@/search/memo-search';

const now = new Date();
type TextSelection = { start: number; end: number };

// REQ-010: preserve paragraph breaks and clip at the measured sixth text line.
function MemoContent({ content, numberOfLines, onOverflowChange }: { content: string; numberOfLines?: number; onOverflowChange: (overflow: boolean) => void }) {
  const theme = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [measuredPreview, setMeasuredPreview] = useState<{ content: string; width: number; fontScale: number; height: number }>();
  const [tagWidths, setTagWidths] = useState<Record<string, number>>({});
  const [textCapHeight, setTextCapHeight] = useState<{ fontScale: number; height: number }>();
  const textLineHeight = 24 * fontScale + 3;
  const tagHeight = 15 * fontScale + 2;
  const capHeight = textCapHeight?.fontScale === fontScale ? textCapHeight.height : 12 * fontScale;
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const memoSegments = normalizedContent.split(/(#[^\s#]*)/g);
  const previewHeight = measuredPreview?.content === content && measuredPreview.width === width && measuredPreview.fontScale === fontScale
    ? measuredPreview.height : 6 * textLineHeight;
  const updatePreviewMeasurement = (height: number, overflow: boolean) => {
    setMeasuredPreview((previous) => previous?.content === content && previous.width === width && previous.fontScale === fontScale && previous.height === height
      ? previous : { content, width, fontScale, height });
    onOverflowChange(overflow);
  };

  return (
    <View style={numberOfLines ? { maxHeight: previewHeight, overflow: "hidden" } : undefined}>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 }}>
        {[...new Set(memoSegments.filter((segment) => segment.startsWith('#')))].map((tag) => (
          <ThemedText key={tag} style={[styles.inlineTag, { alignSelf: 'flex-start' }]} onLayout={(event) => {
            const tagWidth = Math.ceil(event.nativeEvent.layout.width);
            const key = `${fontScale}:${tag}`;
            setTagWidths((previous) => previous[key] === tagWidth ? previous : { ...previous, [key]: tagWidth });
          }}>{tag}</ThemedText>
        ))}
      </View>
      <ThemedText style={[styles.memoContent, { flexShrink: 0, lineHeight: textLineHeight / fontScale }]} onLayout={(event) => {
        // React Native Web does not emit onTextLayout; its full text height remains measurable.
        if (Platform.OS === 'web') {
          const height = 6 * textLineHeight;
          updatePreviewMeasurement(height, event.nativeEvent.layout.height > height + 1);
        }
      }} onTextLayout={(event) => {
        const lines = event.nativeEvent.lines;
        const measuredCapHeight = lines[0]?.capHeight;
        if (measuredCapHeight > 0) {
          setTextCapHeight((previous) => previous?.fontScale === fontScale && previous.height === measuredCapHeight
            ? previous : { fontScale, height: measuredCapHeight });
        }
        const sixthLine = lines[5];
        const height = sixthLine ? sixthLine.y + sixthLine.height : 6 * textLineHeight;
        updatePreviewMeasurement(height, lines.length > 6);
      }}>
        {memoSegments.map((segment, index) => segment.startsWith("#") ? (
          <View key={index} style={[styles.inlineTagPill, {
            width: (tagWidths[`${fontScale}:${segment}`] ?? segment.length * 12 * fontScale) + 8,
            height: tagHeight,
            // Native inline views sit on the text baseline; center the pill on the glyphs.
            transform: [{ translateY: (tagHeight - capHeight) / 2 }],
            backgroundColor: theme.memoTagBackground,
          }]}>
            <ThemedText style={[styles.inlineTag, { color: theme.memoTag }]}>{segment}</ThemedText>
          </View>
        ) : segment)}
      </ThemedText>
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
  const { openSidebar } = useLocalSearchParams<{ openSidebar?: string }>();
  return <HomeScreen openSidebar={openSidebar === '1'} />;
}

function HomeScreen({ openSidebar }: { openSidebar: boolean }) {
  const insets = useSafeAreaInsets();
  const [captureEntryHeight, setCaptureEntryHeight] = useState(48);
  const theme = useTheme();
  const router = useRouter();
  const { connectionStatus, serverUrl, retryConnection } = useServerConnection();
  const { height: windowHeight, width: windowWidth, fontScale } = useWindowDimensions();
  // REQ-058: docs/stories/v0.2.0/REQ-058-horizontal-memo-actions.md
  const memoMenuWidth = Math.min(204 + Math.max(0, fontScale - 1) * 56, 264, windowWidth - insets.left - insets.right - 24);
  const memoMenuHeight = 52 + 40 * fontScale;
  const composerRef = useRef<TextInput>(null);
  const composerSheetRef = useRef<View>(null);
  const [composerInputHeight, setComposerInputHeight] = useState(72);
  const [composerScrollOffset, setComposerScrollOffset] = useState(0);
  const [composerWidth, setComposerWidth] = useState(0);
  const [content, setContent] = useState('');
  const [imageUris, setImageUris] = useState<string[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [importingFile, setImportingFile] = useState(false);
  const [composerSelection, setComposerSelection] = useState<TextSelection>({ start: 0, end: 0 });
  const composerBlurTarget = useRef<View>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [savingMemo, setSavingMemo] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string>();
  const syncProgress = useSyncExternalStore(subscribeMemoSyncProgress, getMemoSyncProgress, getMemoSyncProgress);
  const syncTitle = syncProgress.syncing || refreshing
    ? syncProgress.remainingOperations > 0 ? `同步中[${syncProgress.remainingOperations}]` : '同步中.'
    : undefined;
  const [feedback, setFeedback] = useState<{ title: string; message?: string }>();
  // REQ-067: flomo's deletion notice is exclusive to the home menu.
  const [deletedMemoId, setDeletedMemoId] = useState<string>();
  const [restoringDeletedMemo, setRestoringDeletedMemo] = useState(false);
  const deletionNoticeOpacity = useRef(new Animated.Value(0)).current;
  const deletionPendingRef = useRef(false);
  const restorePendingRef = useRef(false);
  useEffect(() => {
    if (!deletedMemoId || restoringDeletedMemo) return;
    deletionNoticeOpacity.setValue(0);
    Animated.timing(deletionNoticeOpacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const dismissalTimer = setTimeout(() => {
      Animated.timing(deletionNoticeOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setDeletedMemoId((currentId) => currentId === deletedMemoId ? undefined : currentId);
      });
    }, 2000);
    return () => { clearTimeout(dismissalTimer); deletionNoticeOpacity.stopAnimation(); };
  }, [deletedMemoId, restoringDeletedMemo, deletionNoticeOpacity]);

  async function undoHomeDeletion() {
    if (!deletedMemoId || restorePendingRef.current || deletionPendingRef.current) return;
    restorePendingRef.current = true;
    setRestoringDeletedMemo(true);
    try {
      await restoreMemo(deletedMemoId);
      setDeletedMemoId(undefined);
      setMemos(await getMemos());
      void syncHomeChanges();
    } catch (error) {
      console.error('无法撤销删除', error);
      setDeletedMemoId(undefined);
      showFeedback('无法撤销删除', '请在回收站重试恢复；若笔记已被彻底删除，则无法恢复。');
    } finally {
      restorePendingRef.current = false;
      setRestoringDeletedMemo(false);
    }
  }
  const syncHomeChanges = useCallback(async () => {
    try {
      await syncMemoOutbox();
      setMemos(await getMemos());
    } catch {
      setSyncFeedback('变更已保存在手机上，部分记录未同步，请检查连接后重试。');
      try { setMemos(await getMemos()); }
      catch (storageError) {
        console.error('无法刷新记录', storageError);
        setFeedback({ title: '无法刷新记录', message: '请稍后重试。' });
      }
    }
  }, []);
  function showFeedback(title: string, message?: string) { setFeedback({ title, message }); }
  function showStorageError(title: string, error: unknown) {
    console.error(title, error);
    showFeedback(title, '请稍后重试。');
  }
  const refreshingRef = useRef(false);
  const refreshAndSyncRef = useRef<() => void>(() => {});
  const scrollOffsetY = useRef(0);
  const refreshStartedAtTop = useRef(false);
  const [pullOffset] = useState(() => new Animated.Value(0));
  const [imagePreview, setImagePreview] = useState<{ imageUris: string[]; index: number; hidden: boolean }>();
  const imagePagingRef = useRef<ScrollView>(null);
  const setImagePagingForZoom = useCallback((zoomed: boolean) => {
    imagePagingRef.current?.setNativeProps({ scrollEnabled: !zoomed });
  }, []);
  const imagePagingGesture = useMemo(() => Gesture.Native(), []);
  const [fileActionMemo, setFileActionMemo] = useState<Memo & { selectedFileId: string }>();
  const [openMemoMenuId, setOpenMemoMenuId] = useState<string | null>(null);
  const [memoMenuPosition, setMemoMenuPosition] = useState({ left: 0, top: 0 });
  const [expandedMemoIds, setExpandedMemoIds] = useState<string[]>([]);
  const [overflowingMemoIds, setOverflowingMemoIds] = useState<string[]>([]);
  const [searchVisible, setSearchVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<MemoSearchFilters>(emptySearchFilters);
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);
  const [searchSort, setSearchSort] = useState<MemoSearchSort>('created-desc');
  const [filterOpen, setFilterOpen] = useState(openSidebar);
  useEffect(() => {
    if (!openSidebar) return;
    const openingFrame = requestAnimationFrame(() => setFilterOpen(true));
    return () => cancelAnimationFrame(openingFrame);
  }, [openSidebar]);
  // REQ-043: Hidden notes are reached only through the sidebar.
  const hiddenMemoAccess = useHiddenMemoAccess();
  const showingHidden = hiddenMemoAccess.unlocked;
  const searchPartition: SearchPartition = showingHidden ? 'hidden' : 'ordinary';
  const [searchHistory, setSearchHistory] = useState<{ partition: SearchPartition; keywords: string[] }>({ partition: 'ordinary', keywords: [] });
  const searchHistoryQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (!searchVisible) return;
    let active = true;
    searchHistoryQueue.current = searchHistoryQueue.current.then(async () => {
      const keywords = await getSearchHistory(searchPartition);
      if (active) setSearchHistory({ partition: searchPartition, keywords });
    }).catch(() => { if (active) showFeedback('无法读取最近搜索', '本地搜索历史读取失败，请稍后重试。'); });
    return () => { active = false; };
  }, [searchVisible, searchPartition]);

  function saveRecentSearch(keyword?: string) {
    const partition = searchPartition;
    searchHistoryQueue.current = searchHistoryQueue.current.then(async () => {
      const keywords = keyword === undefined ? [] : addRecentSearch(await getSearchHistory(partition), keyword);
      await saveSearchHistory(partition, keywords);
      setSearchHistory({ partition, keywords });
    }).catch(() => showFeedback('无法保存最近搜索', '本地搜索历史保存失败，请稍后重试。'));
  }
  const visibleMemos = useMemo(() => memos.filter((memo) => Boolean(memo.hidden) === showingHidden), [memos, showingHidden]);
  const [visibleYear, setVisibleYear] = useState(now.getFullYear());
  const [visibleMonth, setVisibleMonth] = useState(now.getMonth());
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  useEffect(() => {
    let previouslyUnlocked = hiddenMemoSession.getSnapshot().unlocked;
    return hiddenMemoSession.subscribe(() => {
      const unlocked = hiddenMemoSession.getSnapshot().unlocked;
      const relocked = previouslyUnlocked && !unlocked;
      previouslyUnlocked = unlocked;
      if (!relocked) return;
      setFileActionMemo(undefined);
      setOpenMemoMenuId(null);
      setImagePreview(undefined);
      setExpandedMemoIds([]);
      setQuery('');
      setSearchVisible(false);
      setSearchFiltersOpen(false);
      setSearchFilters(emptySearchFilters());
      setActiveDay(null);
      setActiveTag(null);
    });
  }, []);
  const scrollGesture = useMemo(() => Gesture.Native(), []);
  const searchBackGesture = useMemo(() => Gesture.Pan()
    .enabled(searchVisible && !searchFiltersOpen)
    .activeOffsetX(24)
    .failOffsetY([-18, 18])
    .simultaneousWithExternalGesture(scrollGesture)
    .runOnJS(true)
    .onEnd((event) => { if (event.translationX >= 64) closeSearch(); }), [searchVisible, searchFiltersOpen, scrollGesture]);
  // Gesture callbacks run after rendering; these methods only register them.
  /* eslint-disable react-hooks/refs */
  const refreshGesture = useMemo(
    () => Gesture.Pan()
      .enabled(!searchVisible)
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
        if (refreshingRef.current) return;
        if (refreshStartedAtTop.current && event.translationY >= 70) refreshAndSyncRef.current();
        else Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
      })
      .onFinalize(() => {
        refreshStartedAtTop.current = false;
        if (!refreshingRef.current) Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
      }),
    [pullOffset, scrollGesture, searchVisible],
  );
  /* eslint-enable react-hooks/refs */
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
      initializeWelcomeMemo()
        .then(() => getMemos())
        .then((storedMemos) => {
          if (active) setMemos(storedMemos);
        })
        .catch((error) => {
          console.error('无法初始化或读取记录', error);
          if (active) setFeedback({ title: '无法加载记录', message: '欢迎笔记初始化或记录读取失败，请重新进入首页重试。' });
        });
      return () => {
        active = false;
        setDeletedMemoId(undefined);
        if (hiddenMemoSession.getSnapshot().authenticating) hiddenMemoSession.lock();
      };
    }, [setFeedback, setMemos]),
  );

  useFocusEffect(
    useCallback(() => {
      void syncHomeChanges();
    }, [syncHomeChanges]),
  );

  useFocusEffect(
    useCallback(() => {
      const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (searchVisible) {
          Keyboard.dismiss();
          setQuery('');
          setSearchFilters(emptySearchFilters());
          setSearchFiltersOpen(false);
          setSearchVisible(false);
          return true;
        }
        if (activeDay === null && activeTag === null && !showingHidden) return false;

        setActiveDay(null);
        setActiveTag(null);
        hiddenMemoSession.lock();
        setQuery('');
        setSearchVisible(false);
        setVisibleYear(now.getFullYear());
        setVisibleMonth(now.getMonth());
        return true;
      });

      return () => backSubscription.remove();
    }, [activeDay, activeTag, showingHidden, searchVisible]),
  );

  const tags = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>();
    memos.filter((memo) => !memo.hidden).forEach((memo) => memo.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name));
  }, [memos]);

  const recordDays = useMemo(
    () =>
      new Set(
        visibleMemos
          .filter(
            (memo) =>
              memo.createdOn.getFullYear() === visibleYear && memo.createdOn.getMonth() === visibleMonth,
          )
          .map((memo) => memo.createdOn.getDate()),
      ),
    [visibleMemos, visibleMonth, visibleYear],
  );

  const filteredMemos = useMemo(() => {
    // REQ-055 / REQ-056: Search doesn't inherit the sidebar's day or tag.
    if (searchVisible) return sortSearchMemos(visibleMemos.filter((memo) => matchesMemoSearch(memo, query, searchFilters)), searchSort);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return visibleMemos.filter((memo) => {
      const matchesQuery = !normalizedQuery || memo.content.toLocaleLowerCase().includes(normalizedQuery);
      const matchesDay =
        activeDay === null ||
        (memo.createdOn.getFullYear() === visibleYear &&
          memo.createdOn.getMonth() === visibleMonth &&
          memo.createdOn.getDate() === activeDay);
      const matchesTag = activeTag === null || memo.tags.includes(activeTag);
      return matchesQuery && matchesDay && matchesTag;
    });
  }, [activeDay, activeTag, visibleMemos, query, visibleMonth, visibleYear, searchVisible, searchFilters, searchSort]);

  const canSave = imageUris.length + fileAttachments.length <= 5 && (content.trim().length > 0 || imageUris.length > 0 || fileAttachments.length > 0);
  const fileActionAttachment = fileActionMemo?.fileAttachments.find((file) => file.id === fileActionMemo.selectedFileId);
  const hasActiveConditions = searchVisible ? query.trim().length > 0 || hasSearchFilters(searchFilters) : query.trim().length > 0 || activeDay !== null || activeTag !== null;
  const searchHasResults = searchVisible && (query.trim().length > 0 || hasSearchFilters(searchFilters));
  const searchTags = useMemo(() => [...new Set(visibleMemos.flatMap((memo) => memo.tags))].sort((first, second) => first.localeCompare(second)), [visibleMemos]);
  const tagDraft = findTagDraft(content, composerSelection.start);
  const suggestedTags = tagDraft
    ? tags
        .filter(({ name }) => name.toLocaleLowerCase().includes(tagDraft.query.toLocaleLowerCase()))
        .slice(0, 3)
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
      if (!savingMemo && !importingFile) {
        Keyboard.dismiss();
        setContent('');
        setImageUris([]);
        fileAttachments.forEach(discardImportedFile);
        setFileAttachments([]);
        setComposerSelection({ start: 0, end: 0 });
        setComposerOpen(false);
      }
      return true;
    });
    return () => subscription.remove();
  }, [composerOpen, savingMemo, importingFile, fileAttachments]);

  // REQ-052: sharing appends to the current draft without replacing text or images.
  function receiveFileAttachment(incoming: FileAttachment[]) {
    if (savingMemo || importingFile) {
      incoming.forEach(discardImportedFile);
      showFeedback('暂时无法导入', '请等待当前操作完成，再分享文件。');
      return;
    }
    if (imageUris.length + fileAttachments.length + incoming.length > 5) {
      incoming.forEach(discardImportedFile);
      showFeedback('附件已达上限', '图片和文件合计最多 5 个，请先移除附件。');
      return;
    }
    setFileAttachments((files) => [...files, ...incoming]);
    setComposerOpen(true);
  }

  function showFileError(error: unknown) {
    const message = error instanceof Error ? error.message : '无法读取文件，请重新选择。';
    showFeedback('无法导入文件', message);
  }
  useSharedFile(receiveFileAttachment, showFileError);

  async function chooseMemoFile() {
    if (importingFile || savingMemo) return;
    setImportingFile(true);
    try {
      const selected = await chooseFileAttachments(5 - imageUris.length - fileAttachments.length);
      if (selected.length) setFileAttachments((files) => [...files, ...selected]);
    } catch (error) { showFileError(error); }
    finally { setImportingFile(false); }
  }

  async function saveMemo() {
    const normalizedContent = content.trim();
    if ((!normalizedContent && imageUris.length === 0 && !fileAttachments.length) || savingMemo || importingFile) return;

    const savedAt = new Date();
    setSavingMemo(true);
    try {
      await addMemo({
        id: createUuid(),
        content: normalizedContent,
        createdOn: savedAt,
        imageUris,
        fileAttachments,
      });
      setContent('');
      setImageUris([]);
      fileAttachments.forEach(discardImportedFile);
      setFileAttachments([]);
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
      Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    pullOffset.stopAnimation();
    pullOffset.setValue(80);
    try {
      await syncMemoOutbox();
      setMemos(await getMemos());
    } catch (error) {
      console.error('Unable to synchronize memos', error);
      const reason = error instanceof Error ? error.message : '';
      setSyncFeedback(/http_404|http_405/.test(reason) ? '服务器尚未支持文件上传，请升级 Server 后重试。文件已保存在手机上。'
        : /invalid_api_key|http_401/.test(reason) ? '服务器凭据无效，请更新连接配置后重试。'
        : '部分记录未同步，请检查网络或服务器后重试。');
      try {
        setMemos(await getMemos());
      } catch (storageError) {
        showStorageError('无法刷新记录', storageError);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      Animated.spring(pullOffset, { toValue: 0, useNativeDriver: true }).start();
    }
  }
  useEffect(() => { refreshAndSyncRef.current = refreshAndSync; });

  async function chooseMemoImage() {
    if (importingFile || savingMemo) return;
    const remainingImageCount = 5 - imageUris.length - fileAttachments.length;
    if (remainingImageCount <= 0) {
      showFeedback('图片数量已达上限', '图片和文件合计最多 5 个。');
      return;
    }

    setImportingFile(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showFeedback('需要照片权限', '允许 Sprout 访问照片后，才能为记录添加图片。');
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
        if (result.assets.length > remainingImageCount) throw new Error('图片和文件合计最多 5 个。');
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
        setImageUris((currentImageUris) => [...currentImageUris, ...selectedImageUris]);
      }
    } catch (error) {
      console.error('Failed to select memo image', error);
      showFeedback('无法选择图片', error instanceof Error ? error.message : '请稍后重试。');
    } finally { setImportingFile(false); }
  }

  // REQ-064: docs/stories/v0.2.0/REQ-064-camera-capture.md
  async function captureMemoPhoto() {
    if (importingFile || savingMemo || imageUris.length + fileAttachments.length >= 5) return;
    setImportingFile(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showFeedback('需要相机权限', permission.canAskAgain
          ? '允许 Sprout 使用相机后，才能拍照添加图片。'
          : '请在系统设置中允许 Sprout 使用相机，然后重试。');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'], allowsEditing: false, quality: 0.85,
      });
      if (result.canceled) return;
      const photoUri = result.assets[0]?.uri;
      if (!photoUri) throw new Error('系统相机未返回照片，请重新拍摄。');
      setImageUris((currentImageUris) => [...currentImageUris, photoUri]);
    } catch (error) {
      showFeedback('无法拍照', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      setImportingFile(false);
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
    setSearchFiltersOpen(false);
    setSearchFilters(emptySearchFilters());
  }

  function openSearch() {
    Keyboard.dismiss();
    setQuery('');
    setSearchFilters(emptySearchFilters());
    setSearchVisible(true);
    setSearchSort('created-desc');
  }

  function openComposer() {
    if (showingHidden) return;
    setComposerOpen(true);
  }

  function closeComposer() {
    if (savingMemo || importingFile) return;
    Keyboard.dismiss();
    setContent('');
    setImageUris([]);
    fileAttachments.forEach(discardImportedFile);
    setFileAttachments([]);
    setComposerSelection({ start: 0, end: 0 });
    setComposerOpen(false);
  }

  function toggleMemoMenu(memoId: string, event: GestureResponderEvent) {
    if (openMemoMenuId === memoId) {
      setOpenMemoMenuId(null);
      return;
    }

    // REQ-010: anchor to the button, never the finger's position within it.
    event.currentTarget.measureInWindow((buttonLeft, buttonTop, buttonWidth, buttonHeight) => {
      const screenMargin = 12;
      setMemoMenuPosition({
        left: Math.min(windowWidth - insets.right - memoMenuWidth - screenMargin, Math.max(insets.left + screenMargin, buttonLeft + buttonWidth - memoMenuWidth)),
        top: Math.max(insets.top + screenMargin, Math.min(windowHeight - insets.bottom - memoMenuHeight - screenMargin, buttonTop + buttonHeight + 4)),
      });
      setOpenMemoMenuId(memoId);
    });
  }

  function openFilterPanel() {
    Keyboard.dismiss();
    if (composerOpen) closeComposer();
    setFilterOpen(true);
  }

  function openServerConnection() {
    hiddenMemoSession.lock();
    setFilterOpen(false);
    router.push('/server-connection');
  }

  function selectTagAndCloseFilter(tag: string) {
    // REQ-043: Sidebar tags always select ordinary memos and lock hidden access.
    if (showingHidden) {
      hiddenMemoSession.lock();
      closeSearch();
      setActiveDay(null);
    }
    setActiveTag((currentTag) => (currentTag === tag ? null : tag));
    setFilterOpen(false);
  }

  function changeMonth(offset: number) {
    const nextMonth = shiftMonth(visibleYear, visibleMonth, offset);
    setVisibleYear(nextMonth.year);
    setVisibleMonth(nextMonth.month);
    setActiveDay(null);
  }

  // REQ-044: A cancelled or stale system prompt must never switch the list.
  async function selectMemoVisibility(hidden: boolean) {
    if (!hidden) hiddenMemoSession.lock();
    else {
      Keyboard.dismiss();
      try {
        const result = await hiddenMemoSession.unlock();
        if (!result.success) {
          if (!result.cancelled) {
            showFeedback('无法解锁隐藏笔记', result.message);
          }
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '生物识别验证异常，请稍后重试。';
        showFeedback('无法解锁隐藏笔记', message);
        return;
      }
    }
    setActiveDay(null);
    setActiveTag(null);
    closeSearch();
    setFilterOpen(false);
  }

  return (
    <SwipeSidebar
      open={filterOpen}
      gesturesEnabled={windowWidth < 768 && !composerOpen && !searchVisible}
      width={windowWidth * 0.8}
      onOpenChange={setFilterOpen}
      onEdgeBack={() => {
        hiddenMemoSession.lock();
        closeSearch();
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
                statisticsMemos={memos}
                statisticsVisible={filterOpen}
                onSelectDate={(date) => {
                  setActiveDay(date?.getDate() ?? null);
                  if (date) { setVisibleYear(date.getFullYear()); setVisibleMonth(date.getMonth()); }
                }}
                showingHidden={showingHidden}
                authenticating={hiddenMemoAccess.authenticating}
                onSelectVisibility={selectMemoVisibility}
                activeDay={activeDay}
                activeTag={activeTag}
                connectionStatus={connectionStatus}
                serverUrl={serverUrl}
                onRetryConnection={retryConnection}
                month={visibleMonth}
                onAddServer={openServerConnection}
                onChangeMonth={changeMonth}
                onSelectDay={(day) => setActiveDay((currentDay) => (currentDay === day ? null : day))}
                onSelectTag={selectTagAndCloseFilter}
                onOpenTrash={() => { setFilterOpen(false); router.push('/trash'); }}
                recordDays={recordDays}
                tags={tags}
                width="100%"
                year={visibleYear}
              />
            </SafeAreaView>
      }>
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <BlurTargetView ref={composerBlurTarget} style={[styles.screen, { backgroundColor: theme.background }]}>
        <View collapsable={false} pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.background }]} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.screen, { backgroundColor: theme.background }]}>
          <View style={styles.contentColumn}>
            {!searchVisible && <View style={styles.header}>
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
                  accessibilityLabel={syncTitle ?? activeTag ?? (showingHidden ? '隐藏笔记' : 'Sprout')}
                  accessibilityLiveRegion="polite"
                  numberOfLines={1}
                  style={[styles.wordmark, (syncTitle !== undefined || activeTag !== null) && styles.tagViewTitle]}>
                  {syncTitle ?? activeTag ?? (showingHidden ? '隐藏笔记' : 'Sprout\u00A0')}
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
                  onPress={openSearch}
                  selected={searchVisible}
                />
              </View>
            </View>}

            {searchVisible && (
              <MemoSearchHeader query={query} filters={searchFilters} onQueryChange={setQuery} onCancel={closeSearch} onOpenFilters={() => setSearchFiltersOpen(true)} onSubmit={() => { if (query.trim()) saveRecentSearch(query); }} />
            )}
          </View>
          <GestureDetector gesture={Gesture.Simultaneous(refreshGesture, searchBackGesture)}>
          <View style={styles.refreshArea}>
          <Animated.View
              pointerEvents="none"
              style={[
                styles.refreshIndicator,
                { opacity: pullOffset.interpolate({ inputRange: [20, 56], outputRange: [0, 1], extrapolate: 'clamp' }) },
              ]}>
              <View style={styles.refreshCountRow}>
                <ThemedText style={styles.refreshCountNumber} themeColor="textSecondary">{filteredMemos.length}</ThemedText>
                <ThemedText style={styles.refreshCountLabel} themeColor="textSecondary">条笔记</ThemedText>
              </View>
            </Animated.View>
          <GestureDetector gesture={scrollGesture}>
          <ScrollView
            style={styles.scrollView}
            bounces={false}
            disableScrollViewPanResponder={Platform.OS === 'android'}
            contentContainerStyle={[styles.scrollContent, showingHidden && { paddingBottom: 24 }]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => { scrollOffsetY.current = event.nativeEvent.contentOffset.y; }}
            scrollEventThrottle={16}>
          <Animated.View style={[styles.contentColumn, { transform: [{ translateY: pullOffset }] }]}>
            {searchVisible && !searchHasResults && <MemoSearchShortcuts onSelect={(shortcut) => setSearchFilters({ ...emptySearchFilters(), ...(shortcut === 'untagged' ? { tagRange: 'untagged' as const } : { contentRange: shortcut }) })} />}
            {searchVisible && !searchHasResults && <MemoRecentSearches keywords={searchHistory.partition === searchPartition ? searchHistory.keywords : []} onSelect={(keyword) => { setQuery(keyword); Keyboard.dismiss(); saveRecentSearch(keyword); }} onClear={() => saveRecentSearch()} />}
            {searchHasResults && <MemoSearchSummary count={filteredMemos.length} order={searchSort} onOrderChange={setSearchSort} />}
            {!searchVisible && activeDay !== null && (
              <View style={styles.activeFilterRow}>
                <ThemedText style={styles.activeFilterText} themeColor="textSecondary">
                  {`${visibleMonth + 1} 月 ${activeDay} 日`}
                </ThemedText>
              </View>
            )}

            {searchVisible && !searchHasResults ? null : filteredMemos.length > 0 ? (
              <View style={styles.memoList}>
                {filteredMemos.map((memo) => {
                  const isExpanded = expandedMemoIds.includes(memo.id);
                  const canExpand = overflowingMemoIds.includes(memo.id);
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
                    {memo.content.length > 0 && <MemoContent content={memo.content} numberOfLines={!isExpanded ? 6 : undefined}
                      onOverflowChange={(overflow) => setOverflowingMemoIds((currentIds) => {
                        if (currentIds.includes(memo.id) === overflow) return currentIds;
                        return overflow ? [...currentIds, memo.id] : currentIds.filter((id) => id !== memo.id);
                      })} />}
                    <MemoImages
                      imageUris={memo.imageUris}
                      onOpen={(index) => {
                        if (memo.hidden && !hiddenMemoSession.getSnapshot().unlocked) return;
                        setImagePreview({ imageUris: memo.imageUris, index, hidden: Boolean(memo.hidden) });
                      }}
                    />
                    {memo.fileAttachments.map((attachment) => <Pressable key={attachment.id} accessibilityRole="button" accessibilityLabel={`文件操作 ${attachment.name}`} onPress={() => {
                      if (memo.hidden && !hiddenMemoSession.getSnapshot().unlocked) return;
                      setOpenMemoMenuId(null);
                      setFileActionMemo({ ...memo, selectedFileId: attachment.id });
                    }} style={({ pressed }) => [styles.memoFile, { borderColor: theme.fileBorder, backgroundColor: pressed ? theme.backgroundSelected : theme.fileBackground }]}>
                      <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <FileTypeIcon name={attachment.name} />
                      </View>
                      <ThemedText numberOfLines={2} ellipsizeMode="middle" style={styles.memoFileName}>{attachment.name}</ThemedText>
                    </Pressable>)}
                    {canExpand && (
                      <Pressable
                        accessibilityLabel={isExpanded ? '收起记录正文' : '展开记录正文'}
                        accessibilityRole="button"
                        hitSlop={{ top: 12, bottom: 12, left: 0, right: 12 }}
                        onPress={() => setExpandedMemoIds((currentIds) => isExpanded ? currentIds.filter((id) => id !== memo.id) : [...currentIds, memo.id])}
                        style={({ pressed }) => [styles.expandButton, pressed && styles.pressed]}>
                        <ThemedText style={[styles.expandLabel, { color: theme.memoExpandText }]}>{isExpanded ? '收起' : '展开'}</ThemedText>
                      </Pressable>
                    )}
                  </View>
                  );
                })}
              </View>
            ) : (
              <View style={[styles.emptyState, { borderColor: theme.border }]}>
                <ThemedText style={styles.emptyTitle}>{hasActiveConditions ? '没有找到记录' : showingHidden ? '没有隐藏笔记' : '记下此刻的想法'}</ThemedText>
                <ThemedText style={styles.emptyBody} themeColor="textSecondary">
                  {hasActiveConditions ? searchVisible ? '换个关键词，或者清除筛选再看看。' : '打开侧栏，换个标签或日期再看看。' : showingHidden ? '隐藏的笔记会出现在这里。' : '一句话也值得留下。'}
                </ThemedText>
                {!searchVisible && !hasActiveConditions && <Pressable
                  accessibilityRole="button"
                  onPress={showingHidden ? hiddenMemoSession.lock : openComposer}
                  style={({ pressed }) => [
                    styles.clearButton,
                    { borderColor: theme.border },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText style={styles.clearLabel}>{hasActiveConditions ? '清除筛选' : showingHidden ? '返回全部笔记' : '开始记录'}</ThemedText>
                </Pressable>}
              </View>
            )}
          </Animated.View>
          </ScrollView>
          </GestureDetector>
          </View>
          </GestureDetector>
        </KeyboardAvoidingView>
      </BlurTargetView>

      {!showingHidden && !composerOpen && !searchVisible && (
        <View style={[styles.bottomEntryContainer, { paddingBottom: insets.bottom + CAPTURE_ENTRY_BOTTOM_GAP }]}>
          <CaptureBackdropFade color={theme.background} entryHeight={captureEntryHeight} />
          <Pressable
            accessibilityLabel="点击开始记录"
            onLayout={(event) => setCaptureEntryHeight(event.nativeEvent.layout.height)}
            accessibilityRole="button"
            onPress={openComposer}
            style={({ pressed }) => [styles.bottomEntry, theme === Colors.dark && styles.bottomEntryDark, { backgroundColor: theme.captureBackground, borderColor: theme.captureBorder }, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={23} tintColor={theme.accent} />
            <ThemedText style={styles.bottomEntryLabel} themeColor="captureText">记下此刻的想法…</ThemedText>
          </Pressable>
        </View>
      )}

      {searchVisible && searchFiltersOpen && <MemoSearchFiltersSheet filters={searchFilters} availableTags={searchTags}
        onCancel={() => setSearchFiltersOpen(false)} onApply={(filters) => { setSearchFilters(filters); setSearchFiltersOpen(false); }} />}

      {!showingHidden && composerOpen && (
        <View style={[styles.composerModal, { bottom: keyboardHeight }]}>
          <BlurView blurTarget={composerBlurTarget} blurMethod="dimezisBlurViewSdk31Plus" intensity={12}
            pointerEvents="none" style={StyleSheet.absoluteFill} tint={theme === Colors.dark ? 'dark' : 'light'} />
          <Pressable accessibilityLabel="关闭记录输入" accessibilityRole="button" onPress={closeComposer} style={styles.composerBackdrop} />
          <View ref={composerSheetRef} onLayout={(event) => setComposerWidth(event.nativeEvent.layout.width)} style={[styles.composerSheet, { height: Math.min(184 + Math.ceil(imageUris.length / 3) * 68 + fileAttachments.length * 76, Math.max(184, windowHeight - keyboardHeight - 80)) }, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={[styles.sheetHandle, { backgroundColor: theme.border }]} />
            <ScrollView style={styles.composerBody} keyboardShouldPersistTaps="handled" scrollEventThrottle={16} onScroll={(event) => setComposerScrollOffset(event.nativeEvent.contentOffset.y)}>
            <TextInput
              {...composerTextInputProps}
              ref={composerRef}
              accessibilityLabel="记录此刻的想法"
              autoFocus
              cursorColor={theme.accent}
              multiline
              editable={!savingMemo && !importingFile}
              onSubmitEditing={saveMemo}
              placeholder="现在的想法是..."
              placeholderTextColor={theme.textSecondary}
              selection={composerSelection}
              selectionColor={theme.accent}
              onContentSizeChange={(event) => setComposerInputHeight(Math.max(72, Math.ceil(event.nativeEvent.contentSize.height)))}
              scrollEnabled={false}
              style={[styles.composerInput, { color: theme.text, height: composerInputHeight }]}
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
                      disabled={savingMemo || importingFile}
                      onPress={() => setImageUris((currentImageUris) => currentImageUris.filter((_, imageIndex) => imageIndex !== index))}
                      style={({ pressed }) => [styles.removeImageButton, { backgroundColor: theme.backgroundSelected }, pressed && styles.pressed]}>
                      <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={16} tintColor={theme.text} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
            {fileAttachments.map((attachment) => <FileAttachmentCard key={attachment.uri} attachment={attachment} onRemove={() => {
              if (savingMemo || importingFile) return;
              discardImportedFile(attachment);
              setFileAttachments((files) => files.filter((file) => file.uri !== attachment.uri));
            }} />)}
            </ScrollView>
            {suggestedTags.length > 0 && <CaretTagSuggestions content={content} cursor={composerSelection.start}
              tags={suggestedTags.map(({ name }) => name)} onSelect={selectSuggestedTag}
              inputRef={composerRef} viewportRef={composerSheetRef} padding={2} toolbarInset={72}
              layoutKey={`${composerWidth}:${composerInputHeight}:${composerScrollOffset}:${keyboardHeight}:${imageUris.length}:${fileAttachments.length}`}
              textStyle={styles.composerMeasurement} />}
            <View style={styles.composerActions}>
              <View style={styles.composerMediaActions}>
                <IconButton
                  accessibilityLabel="添加标签"
                  icon={{ ios: 'tag', android: 'tag', web: 'tag' }}
                  iconSource={require('@/assets/icons/tag.svg')}
                  iconSourceSize={22}
                  onPress={addTagPrompt}
                  tintColor={theme.textSecondary}
                  iconSize={18}
                  horizontalHitSlop={0}
                />
                <IconButton
                  accessibilityLabel={`添加图片，附件已选${imageUris.length + fileAttachments.length}个，合计最多5个`}
                  disabled={imageUris.length + fileAttachments.length >= 5 || importingFile || savingMemo}
                  icon={{ ios: 'photo', android: 'photo', web: 'photo' }}
                  iconSource={require('@/assets/icons/image-attachment.svg')}
                  onPress={chooseMemoImage}
                  tintColor={theme.textSecondary}
                  iconSize={18}
                  iconSourceSize={22}
                  horizontalHitSlop={0}
                />
                {Platform.OS !== 'web' && <IconButton accessibilityLabel={importingFile ? '正在导入文件' : '添加文件'}
                  disabled={importingFile || savingMemo || imageUris.length + fileAttachments.length >= 5}
                  icon={{ ios: 'doc.badge.plus', android: 'attach_file', web: 'attach_file' }}
                  iconSource={require('@/assets/icons/file-attachment.svg')} iconSourceSize={22} horizontalHitSlop={0}
                  onPress={chooseMemoFile} tintColor={theme.textSecondary} iconSize={20} />}
                {Platform.OS !== 'web' && <IconButton
                  accessibilityLabel="拍照添加图片"
                  disabled={importingFile || savingMemo || imageUris.length + fileAttachments.length >= 5}
                  icon={{ ios: 'camera', android: 'photo_camera', web: 'photo_camera' }}
                  iconSource={require('@/assets/icons/camera.svg')} iconSourceSize={22} horizontalHitSlop={0}
                  onPress={captureMemoPhoto} tintColor={theme.textSecondary} iconSize={22} />}
              </View>
              <Pressable
                accessibilityLabel="保存记录"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSave || savingMemo }}
                disabled={!canSave || savingMemo || importingFile}
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
            const selectedMemo = visibleMemos.find((memo) => memo.id === openMemoMenuId);
            if (!selectedMemo) return null;
            return (
              <View
                style={[
                  styles.memoMenu,
                  {
                    left: Math.max(insets.left + 12, Math.min(memoMenuPosition.left, windowWidth - insets.right - memoMenuWidth - 12)),
                    top: Math.max(insets.top + 12, Math.min(memoMenuPosition.top, windowHeight - insets.bottom - memoMenuHeight - 12)),
                  },
                  { width: memoMenuWidth, backgroundColor: theme.surface, borderColor: theme.border },
                ]}>
                <Pressable
                  accessibilityLabel="编辑记录"
                  accessibilityRole="button"
                  onPress={() => {
                    if (selectedMemo.hidden && !hiddenMemoSession.getSnapshot().unlocked) return;
                    setOpenMemoMenuId(null);
                    router.push({ pathname: '/memo/[id]', params: { id: selectedMemo.id } });
                  }}
                  style={({ pressed }) => [styles.memoMenuItem, pressed && styles.pressed]}>
                  {/* REQ-010: compact outline pencil with the reference's short baseline. */}
                  <Svg width={16} height={16} viewBox="0 0 24 24" accessible={false}>
                    <Path d="m4 16-1 5 5-1L20 8a2.8 2.8 0 0 0-4-4L4 16Zm10-10 4 4M13 21h8" fill="none" stroke={theme.text} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                  <ThemedText style={styles.memoMenuLabel}>编辑</ThemedText>
                </Pressable>
                <Pressable
                  accessibilityLabel={selectedMemo.hidden ? '取消隐藏笔记' : '隐藏笔记'}
                  accessibilityRole="button"
                  onPress={async () => {
                    if (selectedMemo.hidden && !hiddenMemoSession.getSnapshot().unlocked) return;
                    try {
                      await setMemoHidden(selectedMemo.id, !selectedMemo.hidden);
                      setMemos(await getMemos());
                      setOpenMemoMenuId(null);
                    } catch (error) {
                      showStorageError('无法更新隐藏状态', error);
                    }
                  }}
                  style={({ pressed }) => [styles.memoMenuItem, pressed && styles.pressed]}>
                  <Svg width={16} height={16} viewBox="0 0 24 24" accessible={false}>
                    <Path d={selectedMemo.hidden
                      ? 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'
                      : 'm3 3 18 18M10.5 5.1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3 3.8M6.1 6.1A20 20 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5.9-1.9M9.9 9.9a3 3 0 0 0 4.2 4.2'} fill="none" stroke={theme.text} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                  <ThemedText style={styles.memoMenuLabel}>{selectedMemo.hidden ? '取消隐藏' : '隐藏'}</ThemedText>
                </Pressable>
                <Pressable
                  accessibilityLabel="删除记录"
                  accessibilityRole="button"
                  onPress={async () => {
                    if (selectedMemo.hidden && !hiddenMemoSession.getSnapshot().unlocked) return;
                    if (deletionPendingRef.current || restorePendingRef.current) return;
                    deletionPendingRef.current = true;
                    try {
                      await deleteMemo(selectedMemo.id);
                      setOpenMemoMenuId(null);
                      if (!selectedMemo.hidden) setDeletedMemoId(selectedMemo.id);
                      setMemos(await getMemos());
                      void syncHomeChanges();
                    } catch (error) {
                      showStorageError('无法删除记录', error);
                    } finally {
                      deletionPendingRef.current = false;
                    }
                  }}
                  style={({ pressed }) => [styles.memoMenuItem, pressed && styles.pressed]}>
                  <Svg width={16} height={16} viewBox="0 0 24 24" accessible={false}>
                    <Path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" fill="none" stroke={theme.danger} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
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
        visible={Boolean(imagePreview) && (!imagePreview?.hidden || hiddenMemoAccess.unlocked)}>
        {imagePreview && (!imagePreview.hidden || hiddenMemoAccess.unlocked) && (
          <GestureHandlerRootView style={styles.imagePreviewScreen}>
            <GestureDetector gesture={imagePagingGesture}>
              <ScrollView
                ref={imagePagingRef}
                contentOffset={{ x: imagePreview.index * windowWidth, y: 0 }}
                disableScrollViewPanResponder
                horizontal
                key={`${imagePreview.imageUris.join('|')}-${imagePreview.index}`}
                onMomentumScrollEnd={(event) => {
                  const nextIndex = Math.round(event.nativeEvent.contentOffset.x / windowWidth);
                  setImagePagingForZoom(false);
                  setImagePreview((currentPreview) =>
                    currentPreview ? { ...currentPreview, index: nextIndex } : undefined,
                  );
                }}
                pagingEnabled
                showsHorizontalScrollIndicator={false}>
                {imagePreview.imageUris.map((imageUri, index) => (
                  <View key={`${imageUri}-${index}`} style={[styles.imagePreviewPage, { width: windowWidth }]}>
                    <ZoomableImage uri={imageUri} width={windowWidth} height={windowHeight} pagingGesture={imagePagingGesture} onZoomChange={setImagePagingForZoom} />
                  </View>
                ))}
              </ScrollView>
            </GestureDetector>
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
          </GestureHandlerRootView>
        )}
      </Modal>

      {fileActionMemo && fileActionAttachment && (!fileActionMemo.hidden || hiddenMemoAccess.unlocked) && <FileNameActions
        key={fileActionAttachment.id} name={fileActionAttachment.name} onDismiss={() => setFileActionMemo(undefined)}
        onOpen={() => {
          if (fileActionMemo.hidden && !hiddenMemoSession.getSnapshot().unlocked) return;
          setFileActionMemo(undefined);
          void openFileAttachment(fileActionAttachment).catch((error) => {
            showFeedback('无法查看文件', error instanceof Error ? error.message : '请安装兼容阅读器后重试。');
          });
        }}
        onRename={async (stem) => {
          if (fileActionMemo.hidden && !hiddenMemoSession.getSnapshot().unlocked) throw new Error('隐藏笔记已锁定。');
          await renameMemoFile(fileActionMemo.id, fileActionAttachment.id, stem);
          setMemos(await getMemos());
        }} />}

      {deletedMemoId && (
        <Animated.View accessibilityLiveRegion="polite" style={[styles.deletionNotice, {
          opacity: deletionNoticeOpacity,
          width: Math.min(windowWidth, MaxContentWidth) - 48,
          backgroundColor: theme.backgroundElement,
          borderColor: theme.border,
          bottom: insets.bottom + CAPTURE_ENTRY_BOTTOM_GAP + ((!showingHidden && !searchVisible) ? captureEntryHeight : 0) + 12,
        }]}>
          <ThemedText numberOfLines={1} style={[styles.deletionNoticeText, { color: theme.text }]}>已删除笔记</ThemedText>
          <Pressable accessibilityRole="button" accessibilityLabel="撤销删除"
            disabled={restoringDeletedMemo} onPress={() => void undoHomeDeletion()}
            style={({ pressed }) => [styles.deletionUndoButton, pressed && styles.pressed]}>
            <ThemedText style={[styles.deletionUndoLabel, { color: theme.deletionUndoText }]}>{restoringDeletedMemo ? '恢复中…' : '撤销'}</ThemedText>
          </Pressable>
        </Animated.View>
      )}

      <FeedbackDialog
        onDismiss={() => { if (feedback) setFeedback(undefined); else setSyncFeedback(undefined); }}
        title={feedback?.title ?? syncFeedback ?? ''}
        message={feedback?.message}
        visible={feedback !== undefined || (syncFeedback !== undefined && deletedMemoId === undefined)}
      />
    </SafeAreaView>
    </SwipeSidebar>
  );
}

const styles = StyleSheet.create({
  deletionNotice: { position: 'absolute', alignSelf: 'center', borderWidth: 0.5, borderRadius: 12, paddingLeft: 16, paddingRight: 8, flexDirection: 'row', alignItems: 'center' },
  deletionNoticeText: { flex: 1, fontSize: 15, lineHeight: 20 },
  deletionUndoButton: { minHeight: 48, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  deletionUndoLabel: { fontSize: 15, lineHeight: 20, fontWeight: '700', paddingVertical: 12 },
  screen: { flex: 1 },
  refreshArea: { flex: 1, width: '100%' },
  refreshIndicator: { position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' },
  refreshCountRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingVertical: 8 },
  refreshCountNumber: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  refreshCountLabel: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  scrollView: { flex: 1, width: '100%' },
  scrollContent: { width: '100%', alignItems: 'center', paddingBottom: 144 },
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
  composerModal: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end', alignItems: 'center', zIndex: 10 },
  composerBackdrop: { ...StyleSheet.absoluteFill },
  composerSheet: { width: '100%', maxWidth: MaxContentWidth, maxHeight: '55%', height: 184, alignSelf: 'center', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: Spacing.two, paddingBottom: Spacing.four },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.two },
  composerMeasurement: { fontSize: 16, lineHeight: 24, fontWeight: '400', includeFontPadding: false },
  composerBody: { flex: 1, minHeight: 0 },
  composerInput: { includeFontPadding: false, minHeight: 72, fontSize: 16, lineHeight: 24, fontWeight: '400', padding: 0, paddingTop: 2, paddingHorizontal: 2 },
  composerActions: {
    flexShrink: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.two,
    marginHorizontal: -12,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  composerMediaActions: { flexDirection: 'row', alignItems: 'center' },
  composerImageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: Spacing.one },
  composerImageItem: { position: 'relative', width: 64, height: 64, marginRight: 4, marginBottom: 4 },
  composerImage: { width: '100%', height: '100%', borderRadius: 8 },
  removeImageButton: { position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  composerSendButton: { width: 56, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  bottomEntryContainer: { position: 'absolute', bottom: 0, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: 24 },
  // REQ-008: flomo reference baseline, 312 × 48 dp at a 360 dp viewport.
  bottomEntry: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 24, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.three, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  bottomEntryLabel: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
  bottomEntryDark: { shadowOpacity: 0.24, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
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
  activeFilterRow: {
    minHeight: 32,
    marginBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  activeFilterText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  memoList: { gap: 12 },
  memoFile: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, marginTop: 8, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12 },
  memoFileName: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 21 },
  memo: {
    position: 'relative',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 6,
  },
  memoHeader: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  memoMetadata: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  memoMenuButton: { width: 48, height: 48, marginVertical: -8, marginRight: -8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  memoMenuModal: { flex: 1 },
  memoMenu: { position: 'absolute', flexDirection: 'row', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 8, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 5 },
  memoMenuItem: { flex: 1, minWidth: 48, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, borderRadius: 8 },
  memoMenuLabel: { fontSize: 14, lineHeight: 20, fontWeight: '600', textAlign: 'center' },
  memoTime: { flexShrink: 1, fontSize: 12, lineHeight: 18, fontWeight: '400' },
  memoContent: { flexShrink: 1, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  memoImage: { width: 120, height: 180, borderRadius: 6, marginTop: 10, overflow: 'hidden' },
  memoImageContent: { width: '100%', height: '100%' },
  memoImageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  memoGridImage: { width: 84, height: 84, borderRadius: 6, overflow: 'hidden' },
  imagePreviewScreen: { flex: 1, backgroundColor: '#000000' },
  imagePreviewPage: { height: '100%', alignItems: 'center', justifyContent: 'center' },
  imagePreviewCounter: { position: 'absolute', top: 58, alignSelf: 'center', color: '#FFFFFF', fontSize: 14, lineHeight: 20 },
  imagePreviewClose: { position: 'absolute', top: 44, right: 18, width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: 'rgba(0, 0, 0, 0.42)' },
  inlineTagPill: { borderRadius: 6, paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden' },
  inlineTag: { fontSize: 12, lineHeight: 15, fontWeight: '400', includeFontPadding: false },
  expandButton: { alignSelf: 'flex-start', minHeight: 20, justifyContent: 'center' },
  expandLabel: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
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
