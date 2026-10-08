// REQ-067: docs/stories/v0.2.0/REQ-067-trash-interface.md
import { useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Image } from 'expo-image';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackDialog } from '@/components/feedback-dialog';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useHiddenMemoAccess } from '@/hooks/use-hidden-memo-access';
import { hiddenMemoSession } from '@/auth/hidden-memo-session';
import { clearTrashMemos, getTrashMemos, purgeMemo, restoreMemo } from '@/storage/memos';
import { getMemoSyncProgress, subscribeMemoSyncProgress, syncMemoOutbox } from '@/sync/memo-outbox';
import { getServerConnectionConfig } from '@/storage/server-connection';
import type { Memo } from '@/types/memo';

type Dialog = { title: string; message: string; action?: () => Promise<void>; label?: string };

function formatTrashTime(value: Date) {
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function describeTrashSyncFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '连接 Server 后重试。';
  if (message.includes('note_expired')) return '笔记已超过 30 天，无法恢复。';
  if (message.includes('version_conflict')) return '笔记已在其他设备发生变化，请刷新后重试。';
  if (message.includes('note_not_found')) return '笔记已从 Server 彻底删除。';
  return message;
}

export default function TrashScreen() {
  const router = useRouter();
  const theme = useTheme();
  const hiddenAccess = useHiddenMemoAccess();
  const [memos, setMemos] = useState<Memo[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [openMenuId, setOpenMenuId] = useState<string>();
  const syncProgress = useSyncExternalStore(subscribeMemoSyncProgress, getMemoSyncProgress, getMemoSyncProgress);

  const reload = useCallback(async () => setMemos(await getTrashMemos()), []);
  const syncAndReload = useCallback(async () => {
    const config = await getServerConnectionConfig();
    if (config) await syncMemoOutbox();
    await reload();
  }, [reload]);

  useFocusEffect(useCallback(() => {
    let active = true;
    void (async () => {
      try {
        await reload();
      } catch (error) {
        if (active) setDialog({ title: '无法加载回收站', message: error instanceof Error ? error.message : '请稍后重试。' });
        return;
      }
      if (!active) return;
      try {
        if (await getServerConnectionConfig()) await syncAndReload();
      } catch (error) {
        if (active) setDialog({ title: '等待同步', message: describeTrashSyncFailure(error) });
      }
    })();
    return () => { active = false; hiddenMemoSession.lock(); };
  }, [reload, syncAndReload]));

  async function apply(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setOpenMenuId(undefined);
      await reload();
      try { await syncAndReload(); } catch (error) {
        await reload();
        setDialog({ title: '等待同步', message: describeTrashSyncFailure(error) });
      }
    } catch (error) {
      setDialog({ title: '操作未完成', message: error instanceof Error ? error.message : '请稍后重试。' });
    } finally {
      setBusy(false);
    }
  }

  function confirmPurge(memo: Memo) {
    setDialog({ title: '彻底删除这条笔记？', message: '删除后无法恢复。', label: '彻底删除', action: () => purgeMemo(memo.id) });
  }

  function confirmClear() {
    setDialog({ title: '清空回收站？', message: '回收站中的所有笔记及附件都将永久删除，无法恢复。', label: '清空', action: clearTrashMemos });
  }

  async function unlockHidden() {
    try {
      const result = await hiddenMemoSession.unlock();
      if (!result.success && !result.cancelled) setDialog({ title: '无法解锁隐藏笔记', message: result.message ?? '请稍后重试。' });
    } catch (error) {
      setDialog({ title: '无法解锁隐藏笔记', message: error instanceof Error ? error.message : '请稍后重试。' });
    }
  }

  return <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="打开侧栏" onPress={() => router.replace({ pathname: '/', params: { openSidebar: '1' } })} style={styles.headerButton}>
        <SymbolView name={{ ios: 'line.3.horizontal', android: 'menu', web: 'menu' }} size={24} tintColor={theme.textSecondary} />
      </Pressable>
      <ThemedText accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.title}>
        {syncProgress.syncing ? syncProgress.remainingOperations > 0 ? `同步中[${syncProgress.remainingOperations}]` : '同步中.' : '回收站'}
      </ThemedText>
      <Pressable accessibilityRole="button" accessibilityLabel="清空回收站" disabled={busy || memos.length === 0} onPress={confirmClear} style={styles.headerButton}>
        <ThemedText style={[styles.headerAction, { color: memos.length ? theme.danger : theme.textSecondary }]}>清空</ThemedText>
      </Pressable>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText style={[styles.noticeIcon, { color: theme.danger }]}>!</ThemedText>
        <ThemedText style={[styles.noticeText, { color: theme.textSecondary }]}>在回收站中超过 30 天的笔记将会自动删除</ThemedText>
      </View>
      {memos.length === 0 && <ThemedText style={[styles.empty, { color: theme.textSecondary }]}>回收站是空的</ThemedText>}
      {memos.map((memo) => {
        const locked = memo.hidden && !hiddenAccess.unlocked;
        return <View key={memo.id} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.cardHeader}>
            <ThemedText style={[styles.date, { color: theme.textSecondary }]}>删除于 {memo.deletedAt ? formatTrashTime(memo.deletedAt) : '待同步'}</ThemedText>
            <Pressable accessibilityRole="button" accessibilityLabel="笔记更多操作" accessibilityState={{ expanded: openMenuId === memo.id }} disabled={busy || locked} onPress={() => setOpenMenuId(openMenuId === memo.id ? undefined : memo.id)} style={styles.moreButton}>
              <SymbolView name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }} size={20} tintColor={theme.textSecondary} />
            </Pressable>
          </View>
          {locked ? <Pressable accessibilityRole="button" accessibilityLabel="解锁隐藏笔记" onPress={() => { void unlockHidden(); }}>
            <ThemedText style={{ color: theme.accent }}>隐藏笔记 · 点击验证后查看</ThemedText>
          </Pressable> : <>
            {memo.content ? <ThemedText numberOfLines={5} style={styles.memoContent}>{memo.content}</ThemedText> : null}
            {memo.imageUris[0] ? <Image source={{ uri: memo.imageUris[0] }} style={styles.thumbnail} contentFit="cover" /> : null}
            {memo.fileAttachments.map((file) => <ThemedText key={file.id} numberOfLines={1} style={[styles.fileName, { color: theme.textSecondary }]}>{file.name}</ThemedText>)}
          </>}
          {openMenuId === memo.id && <View style={[styles.menu, { backgroundColor: theme.background, borderColor: theme.border }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="恢复笔记" disabled={busy} onPress={() => { void apply(() => restoreMemo(memo.id)); }} style={styles.menuAction}>
              <ThemedText style={{ color: theme.text }}>恢复</ThemedText>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="彻底删除笔记" disabled={busy} onPress={() => { setOpenMenuId(undefined); confirmPurge(memo); }} style={styles.menuAction}>
              <ThemedText style={{ color: theme.danger }}>彻底删除</ThemedText>
            </Pressable>
            {!memo.expiresAt && <ThemedText style={[styles.menuExpiry, { color: theme.textSecondary }]}>待同步</ThemedText>}
          </View>}
        </View>;
      })}
      {busy && <ActivityIndicator color={theme.accent} />}
    </ScrollView>
    <FeedbackDialog visible={dialog !== undefined} title={dialog?.title ?? ''} message={dialog?.message} onDismiss={() => setDialog(undefined)}
      destructiveAction={dialog?.action && dialog.label ? { label: dialog.label, onPress: () => {
        const action = dialog.action;
        setDialog(undefined);
        if (action) void apply(action);
      } } : undefined} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerButton: { minWidth: 72, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerAction: { fontSize: 18 },
  title: { fontSize: 20, fontWeight: '700' },
  content: { paddingHorizontal: 12, paddingBottom: 48, paddingTop: 4 },
  notice: { minHeight: 36, borderRadius: 12, marginBottom: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  noticeIcon: { width: 14, height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: '#E99A9A', color: '#FFFFFF', textAlign: 'center', textAlignVertical: 'center', fontSize: 10, lineHeight: 14, fontWeight: '700' },
  noticeText: { flexShrink: 1, fontSize: 13, lineHeight: 20, fontWeight: '400' },
  empty: { paddingTop: 100, textAlign: 'center', fontSize: 16 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  date: { fontSize: 12 },
  moreButton: { width: 44, height: 32, alignItems: 'center', justifyContent: 'center' },
  memoContent: { fontSize: 16, lineHeight: 24 },
  thumbnail: { width: 152, height: 152, borderRadius: 8, marginTop: 12 },
  fileName: { fontSize: 13, marginTop: 8 },
  menu: { position: 'absolute', zIndex: 2, top: 46, right: 14, minWidth: 152, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, elevation: 4 },
  menuAction: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' },
  menuExpiry: { fontSize: 11, paddingHorizontal: 16, paddingBottom: 10 },
});
