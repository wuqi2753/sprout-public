import { SymbolView } from 'expo-symbols';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { FileTypeIcon } from '@/components/file-type-icon';
import * as ImagePicker from 'expo-image-picker';

import { Pressable } from '@/components/haptic-pressable';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedbackDialog } from '@/components/feedback-dialog';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { deleteMemo, getMemo, getMemos, updateMemoDraft } from '@/storage/memos';
import { findTagDraft } from '@/memos';
import { chooseFileAttachments, discardImportedFile } from '@/storage/import-file';
import { CaretTagSuggestions } from '@/components/caret-tag-suggestions';
import { MemoEditorToolbar } from '@/components/memo-editor-toolbar';
import { MemoTimePicker } from '@/components/memo-time-picker';
import type { FileAttachment } from '@/types/attachment';
import type { Memo } from '@/types/memo';
import { hiddenMemoSession } from '@/auth/hidden-memo-session';
import { useHiddenMemoAccess } from '@/hooks/use-hidden-memo-access';

// REQ-047: keep thumbnail removal proportions independent of toolbar icons.
const IMAGE_REMOVE_CIRCLE_SIZE = 24;
const IMAGE_REMOVE_ICON_SIZE = 14;
const IMAGE_REMOVE_INSET = 4;
const IMAGE_REMOVE_TOUCH_SIZE = 48;

function formatSavedAt(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function EditMemoScreen() {
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [memo, setMemo] = useState<Memo>();
  const [content, setContent] = useState('');
  const [createdOn, setCreatedOn] = useState<Date>();
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imageUris, setImageUris] = useState<string[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [choosingAttachment, setChoosingAttachment] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [inputHeight, setInputHeight] = useState(52);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [editorAvailableHeight, setEditorAvailableHeight] = useState(0);
  const [editorContentHeight, setEditorContentHeight] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyTags, setHistoryTags] = useState<string[]>([]);
  const inputRef = useRef<TextInput>(null);
  const editorBodyRef = useRef<View>(null);
  const [editorScrollOffset, setEditorScrollOffset] = useState(0);
  const [editorWidth, setEditorWidth] = useState(0);
  const [feedback, setFeedback] = useState<{ title: string; message?: string }>();
  const importedFilesRef = useRef<FileAttachment[]>([]);
  const activeRef = useRef(true);
  const deletingRef = useRef(false);
  const hiddenMemoAccess = useHiddenMemoAccess();
  const hiddenMemoLocked = Boolean(memo?.hidden) && !hiddenMemoAccess.unlocked;
  const canSave = Boolean(memo) && imageUris.length + fileAttachments.length <= 5 && Boolean(content.trim() || imageUris.length || fileAttachments.length) && !saving && !choosingAttachment && !hiddenMemoLocked;
  const draftChanged = Boolean(memo) && (createdOn?.getTime() !== memo!.createdOn.getTime() || content !== memo!.content || imageUris.length !== memo!.imageUris.length
    || imageUris.some((uri, index) => uri !== memo!.imageUris[index]) || fileAttachments.length !== memo!.fileAttachments.length || fileAttachments.some((file, index) => file.uri !== memo!.fileAttachments[index]?.uri || file.name !== memo!.fileAttachments[index]?.name));
  const tagDraft = findTagDraft(content, selection.start);
  const suggestedTags = !hiddenMemoLocked && tagDraft
    ? historyTags.filter((name) => name.toLocaleLowerCase().includes(tagDraft.query.toLocaleLowerCase())).slice(0, 5) : [];

  useEffect(() => {
    let active = true;
    getMemos().then((storedMemos) => {
      const counts = new Map<string, number>();
      storedMemos.filter((storedMemo) => !storedMemo.hidden).forEach((storedMemo) => storedMemo.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
      if (active) setHistoryTags([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag));
    }).catch((error) => showEditError('无法读取历史标签', error));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      importedFilesRef.current.forEach(discardImportedFile);
    };
  }, []);

  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    if (saving || choosingAttachment) event.preventDefault();
  }), [navigation, saving, choosingAttachment]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // REQ-047: Open the IME after loading and after the native route transition.
  useEffect(() => {
    if (!memo?.id || hiddenMemoLocked) return;
    let frame: number | undefined;
    const openKeyboard = () => {
      if (!activeRef.current || !navigation.isFocused()) return;
      // Android focus() alone is a no-op if navigation hid an already focused IME.
      inputRef.current?.blur();
      frame = requestAnimationFrame(() => inputRef.current?.focus());
    };
    const timer = setTimeout(openKeyboard, 350);
    const stackNavigation = navigation as typeof navigation & {
      addListener(name: 'transitionEnd', callback: (event: { data: { closing: boolean } }) => void): () => void;
    };
    const unsubscribe = stackNavigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing) { clearTimeout(timer); openKeyboard(); }
    });
    return () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [navigation, memo?.id, hiddenMemoLocked]);

  useEffect(() => {
    let active = true;
    if (!id) return;
    getMemo(id)
      .then((storedMemo) => {
        if (!active) return;
        if (!storedMemo) throw new Error(`Cannot edit missing memo: ${id}`);
        setMemo(storedMemo);
        setCreatedOn(storedMemo.createdOn);
        setContent(storedMemo.hidden && !hiddenMemoSession.getSnapshot().unlocked ? '' : storedMemo.content);
        setImageUris(storedMemo.imageUris);
        setFileAttachments(storedMemo.fileAttachments);
      })
      .catch((error) => showEditError('无法读取记录', error));
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (memo && !memo.hidden) hiddenMemoSession.lock();
    return hiddenMemoSession.subscribe(() => {
      if (memo?.hidden && !hiddenMemoSession.getSnapshot().unlocked) {
        setContent('');
        Keyboard.dismiss();
      }
    });
  }, [memo]);

  function showEditError(title: string, error: unknown) {
    console.error(title, error);
    setFeedback({ title, message: '请稍后重试。' });
  }

  async function copyDraftText() {
    if (!canChangeDraft()) return;
    try {
      await Clipboard.setStringAsync(content);
      setMenuOpen(false);
    } catch (error) { showEditError('无法复制全文', error); }
  }

  async function deleteEditedMemo() {
    if (!memo || !canChangeDraft() || deletingRef.current) return;
    deletingRef.current = true;
    setSaving(true);
    try {
      await deleteMemo(memo.id);
      setMenuOpen(false);
      setSaving(false);
      requestAnimationFrame(() => router.back());
    } catch (error) { showEditError('无法删除记录', error); }
    finally { deletingRef.current = false; setSaving(false); }
  }

  function canChangeDraft() {
    return activeRef.current && Boolean(memo) && !saving && !(memo?.hidden && !hiddenMemoSession.getSnapshot().unlocked);
  }

  function insertTag() {
    if (!canChangeDraft()) return;
    const insertion = `${selection.start > 0 && !/\s/.test(content[selection.start - 1]) ? ' ' : ''}#`;
    setContent(`${content.slice(0, selection.start)}${insertion}${content.slice(selection.end)}`);
    const cursor = selection.start + insertion.length;
    inputRef.current?.focus();
    requestAnimationFrame(() => {
      setSelection({ start: cursor, end: cursor });
      inputRef.current?.setNativeProps({ selection: { start: cursor, end: cursor } });
    });
  }

  function selectSuggestedTag(tag: string) {
    if (!tagDraft || !canChangeDraft()) return;
    const insertion = `#${tag} `;
    const nextSelection = { start: tagDraft.start + insertion.length, end: tagDraft.start + insertion.length };
    setContent(`${content.slice(0, tagDraft.start)}${insertion}${content.slice(tagDraft.end)}`);
    inputRef.current?.focus();
    requestAnimationFrame(() => {
      setSelection(nextSelection);
      inputRef.current?.setNativeProps({ selection: nextSelection });
    });
  }

  async function chooseImages() {
    if (!canChangeDraft() || choosingAttachment || imageUris.length + fileAttachments.length >= 5) return;
    setChoosingAttachment(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error('需要照片权限，请允许 Sprout 访问照片。');
      if (!canChangeDraft()) return;
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true,
        selectionLimit: 5 - imageUris.length - fileAttachments.length, allowsEditing: false, quality: 0.85 });
      if (!result.canceled && canChangeDraft()) {
        if (result.assets.length + imageUris.length + fileAttachments.length > 5) throw new Error('图片和文件合计最多 5 个。');
        setImageUris((uris) => [...uris, ...result.assets.map((asset) => asset.uri)]);
      }
    } catch (error) {
      showAttachmentError(error);
    } finally {
      if (activeRef.current) setChoosingAttachment(false);
    }
  }

  function showAttachmentError(error: unknown) {
    const message = error instanceof Error ? error.message : '请稍后重试。';
    setFeedback({ title: '无法添加附件', message });
  }

  async function chooseFile() {
    if (!canChangeDraft() || choosingAttachment) return;
    setChoosingAttachment(true);
    try {
      const selected = await chooseFileAttachments(5 - imageUris.length - fileAttachments.length);
      if (!canChangeDraft()) { selected.forEach(discardImportedFile); return; }
      importedFilesRef.current.push(...selected);
      setFileAttachments((files) => [...files, ...selected]);
    } catch (error) {
      showAttachmentError(error);
    } finally {
      if (activeRef.current) setChoosingAttachment(false);
    }
  }

  async function saveMemo() {
    const normalizedContent = content.trim();
    if (!memo || !canSave || (memo.hidden && !hiddenMemoSession.getSnapshot().unlocked)) return;
    setSaving(true);
    try {
      await updateMemoDraft(memo.id, { content: normalizedContent, imageUris, fileAttachments,
        ...(createdOn?.getTime() !== memo.createdOn.getTime() ? { createdOn } : {}) }, new Date());
      setSaving(false);
      // Release the navigation guard before returning to the timeline.
      requestAnimationFrame(() => router.back());
    } catch (error) {
      showEditError('无法保存修改', error);
    } finally {
      setSaving(false);
    }
  }

  // REQ-044: A direct route or expired session cannot render the hidden editor.
  if (hiddenMemoLocked) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
        <View style={styles.lockedContent}>
          <ThemedText style={styles.title}>隐藏笔记已锁定</ThemedText>
          <ThemedText themeColor="textSecondary">请返回首页，从左侧栏验证后查看。</ThemedText>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.returnButton, { backgroundColor: theme.accent }, pressed && styles.pressed]}>
            <ThemedText style={{ color: theme.onAccent }}>返回首页</ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* REQ-047: keep attachments and toolbar above the keyboard on both mobile platforms. */}
      <KeyboardAvoidingView behavior={Platform.OS === 'web' ? undefined : 'padding'} style={styles.screen}>
        <View style={styles.header}>
          <Pressable accessibilityLabel={draftChanged ? '保存修改' : '取消编辑'} accessibilityRole="button" disabled={saving || (draftChanged && !canSave)} accessibilityState={{ disabled: saving || (draftChanged && !canSave) }} onPress={draftChanged ? saveMemo : () => router.back()} style={styles.headerButton}>
            <View style={[styles.headerButtonCircle, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <SymbolView name={draftChanged ? { ios: 'checkmark', android: 'check', web: 'check' } : { ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }} size={20} tintColor={draftChanged && !canSave ? theme.textSecondary : theme.text} />
            </View>
          </Pressable>
          <View style={styles.titleGroup}>
            <ThemedText style={styles.title}>编辑</ThemedText>
            <Pressable accessibilityRole="button" accessibilityLabel="修改记录时间" disabled={!memo || saving || choosingAttachment}
              onPress={() => { if (canChangeDraft()) { Keyboard.dismiss(); setTimePickerOpen(true); } }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 }}>
              <ThemedText style={styles.savedAt} themeColor="textSecondary">{createdOn ? formatSavedAt(createdOn) : '正在读取…'}</ThemedText>
              {memo && <SymbolView name={{ ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' }} size={14} tintColor={theme.textSecondary} />}
            </Pressable>
          </View>
          <Pressable accessibilityLabel="编辑更多操作" accessibilityRole="button" disabled={!memo || saving} onPress={() => setMenuOpen(!menuOpen)} style={styles.headerButton}>
            <View style={[styles.headerButtonCircle, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <SymbolView name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }} size={20} tintColor={theme.text} />
            </View>
          </Pressable>
        </View>
        <View ref={editorBodyRef} style={styles.editorBody} onLayout={(event) => { setEditorAvailableHeight(event.nativeEvent.layout.height); setEditorWidth(event.nativeEvent.layout.width); }}>
        <ScrollView style={keyboardVisible ? { height: Math.min(editorContentHeight || 184, editorAvailableHeight || 184) } : styles.editorContent}
          scrollEventThrottle={16} onScroll={(event) => setEditorScrollOffset(event.nativeEvent.contentOffset.y)}
          onContentSizeChange={(_width, height) => setEditorContentHeight(height)} contentContainerStyle={styles.editorContentContainer}
          keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
        <TextInput
          ref={inputRef}
          accessibilityLabel={fileAttachments.length ? '编辑记录说明，不修改文件内容' : '编辑记录正文'}
          editable={Boolean(memo) && !saving}
          multiline
          onChangeText={setContent}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          onContentSizeChange={(event) => setInputHeight(Math.max(52, Math.ceil(event.nativeEvent.contentSize.height)))}
          placeholder="记录此刻的想法"
          placeholderTextColor={theme.textSecondary}
          selectionColor={theme.accent}
          scrollEnabled={false}
          style={[styles.input, { height: inputHeight, color: theme.text }]}
          textAlignVertical="top"
          value={content}
        />
        {/* REQ-047: draft attachments are editable; the file body stays untouched. */}
        {imageUris.length > 0 && <View style={styles.images}>
          {imageUris.map((uri, index) => <View key={`${uri}-${index}`} style={styles.thumbnail}>
            <Image source={{ uri }} style={styles.preview} contentFit="cover" />
            <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 张图片`}
              disabled={saving || choosingAttachment} onPress={() => setImageUris((uris) => uris.filter((_, position) => position !== index))}
              accessibilityState={{ disabled: saving || choosingAttachment }}
              style={({ pressed }) => [styles.removeImage, { opacity: saving || choosingAttachment ? 0.4 : pressed ? 0.6 : 1 }]}>
              <View style={[styles.removeImageIcon, { backgroundColor: theme.surface }]}>
                <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={IMAGE_REMOVE_ICON_SIZE} tintColor={theme.text} />
              </View>
            </Pressable>
          </View>)}
        </View>}
        {fileAttachments.map((attachment) => <View key={attachment.uri} style={[styles.fileRow, { backgroundColor: theme.fileBackground, borderColor: theme.fileBorder }]}>
          <View accessible={false} style={[styles.fileIcon, { backgroundColor: theme.backgroundElement }]}>
            <FileTypeIcon name={attachment.name} />
          </View>
          <ThemedText numberOfLines={2} ellipsizeMode="middle" style={styles.fileName}>{attachment.name}</ThemedText>
          <Pressable accessibilityRole="button" accessibilityLabel={`移除文件 ${attachment.name}`} disabled={saving || choosingAttachment}
            accessibilityState={{ disabled: saving || choosingAttachment }}
            onPress={() => {
              if (!canChangeDraft() || choosingAttachment) return;
              if (importedFilesRef.current.some((file) => file.uri === attachment.uri)) {
                discardImportedFile(attachment);
                importedFilesRef.current = importedFilesRef.current.filter((file) => file.uri !== attachment.uri);
              }
              setFileAttachments((files) => files.filter((file) => file.uri !== attachment.uri));
            }}
            style={({ pressed }) => [styles.removeFile, { opacity: saving || choosingAttachment ? 0.4 : pressed ? 0.6 : 1 }]}>
            <View style={[styles.removeFileIcon, { backgroundColor: theme.backgroundElement }]}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={16} tintColor={theme.text} />
            </View>
          </Pressable>
        </View>)}
        </ScrollView>
        {suggestedTags.length > 0 && keyboardVisible && <CaretTagSuggestions content={content} cursor={selection.start}
          tags={suggestedTags} onSelect={selectSuggestedTag} inputRef={inputRef} viewportRef={editorBodyRef}
          layoutKey={`${editorWidth}:${inputHeight}:${editorAvailableHeight}:${editorContentHeight}:${editorScrollOffset}`}
          textStyle={styles.inputMeasurement} />}
        </View>
        <MemoEditorToolbar disabled={!memo || saving || choosingAttachment} imageCount={imageUris.length}
          fileCount={fileAttachments.length} onTag={insertTag} onImage={chooseImages} onFile={chooseFile} />
      </KeyboardAvoidingView>
      {timePickerOpen && createdOn && <MemoTimePicker date={createdOn} onCancel={() => setTimePickerOpen(false)}
        onConfirm={(date) => { if (canChangeDraft()) setCreatedOn(date); setTimePickerOpen(false); }} />}
      {menuOpen && <View style={styles.menuOverlay}>
        <Pressable accessibilityLabel="关闭编辑菜单" onPress={() => setMenuOpen(false)} style={StyleSheet.absoluteFill} />
        <View style={[styles.menu, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="复制全文" onPress={copyDraftText} disabled={saving} style={styles.menuItem}>
            <ThemedText style={styles.menuLabel}>复制全文</ThemedText>
          </Pressable>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border }} />
          <Pressable accessibilityRole="button" accessibilityLabel="删除记录" onPress={() => void deleteEditedMemo()} disabled={saving} style={styles.menuItem}>
            <ThemedText style={[styles.menuLabel, { color: theme.danger }]}>删除</ThemedText>
          </Pressable>
        </View>
      </View>}
      <FeedbackDialog visible={feedback !== undefined} title={feedback?.title ?? ''} message={feedback?.message}
        onDismiss={() => setFeedback(undefined)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  lockedContent: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three, padding: Spacing.three },
  returnButton: { minHeight: 48, paddingHorizontal: Spacing.three, borderRadius: 13, justifyContent: 'center' },
  header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.three },
  headerButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerButtonCircle: { width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  menuOverlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 10 },
  menu: { position: 'absolute', top: 92, right: 16, width: 140, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 4, elevation: 6, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  menuItem: { minHeight: 48, justifyContent: 'center' },
  menuLabel: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { fontSize: 17, lineHeight: 24, fontWeight: '700' },
  titleGroup: { flex: 1, alignItems: 'center', gap: 1 },
  savedAt: { fontSize: 11, lineHeight: 16 },
  editorContent: { flex: 1 },
  editorBody: { flex: 1, minHeight: 0, justifyContent: 'flex-end' },
  editorContentContainer: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: 12 },
  inputMeasurement: { fontSize: 17, lineHeight: 26, includeFontPadding: false },
  input: { includeFontPadding: false, minHeight: 52, padding: 0, fontSize: 17, lineHeight: 26 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, paddingVertical: 8, paddingLeft: 12, paddingRight: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16 },
  fileIcon: { width: 40, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  fileName: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 21, fontWeight: '500' },
  removeFile: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  removeFileIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  thumbnail: { width: 84, height: 84 },
  preview: { width: 84, height: 84, borderRadius: 8 },
  removeImage: { position: 'absolute', top: 0, right: 0, width: IMAGE_REMOVE_TOUCH_SIZE, height: IMAGE_REMOVE_TOUCH_SIZE, padding: IMAGE_REMOVE_INSET, alignItems: 'flex-end', justifyContent: 'flex-start' },
  removeImageIcon: { width: IMAGE_REMOVE_CIRCLE_SIZE, height: IMAGE_REMOVE_CIRCLE_SIZE, borderRadius: IMAGE_REMOVE_CIRCLE_SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
