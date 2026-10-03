import { SymbolView } from 'expo-symbols';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';

import { Pressable } from '@/components/haptic-pressable';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getMemo, updateMemoContent } from '@/storage/memos';
import type { Memo } from '@/types/memo';

function formatSavedAt(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function EditMemoScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [memo, setMemo] = useState<Memo>();
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const canSave = Boolean(memo) && content.trim().length > 0 && !saving;

  useEffect(() => {
    let active = true;
    if (!id) return;
    getMemo(id)
      .then((storedMemo) => {
        if (!active) return;
        if (!storedMemo) throw new Error(`Cannot edit missing memo: ${id}`);
        setMemo(storedMemo);
        setContent(storedMemo.content);
      })
      .catch((error) => showEditError('无法读取记录', error));
    return () => {
      active = false;
    };
  }, [id]);

  function showEditError(title: string, error: unknown) {
    console.error(title, error);
    if (Platform.OS === 'web') window.alert(`${title}，请稍后重试。`);
    else Alert.alert(title, '请稍后重试。');
  }

  async function saveMemo() {
    const normalizedContent = content.trim();
    if (!memo || !normalizedContent || saving) return;
    setSaving(true);
    try {
      await updateMemoContent(memo.id, normalizedContent, new Date());
      router.back();
    } catch (error) {
      showEditError('无法保存修改', error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="取消编辑" accessibilityRole="button" onPress={() => router.back()} style={styles.headerButton}>
            <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={theme.text} />
          </Pressable>
          <View style={styles.titleGroup}>
            <ThemedText style={styles.title}>编辑</ThemedText>
            <ThemedText style={styles.savedAt} themeColor="textSecondary">
              {memo ? `最后保存于 ${formatSavedAt(memo.savedAt)}` : '正在读取…'}
            </ThemedText>
          </View>
          <Pressable
            accessibilityLabel="保存修改"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={saveMemo}
            style={({ pressed }) => [styles.saveButton, { backgroundColor: canSave ? theme.accent : theme.backgroundSelected }, pressed && canSave && styles.pressed]}>
            <ThemedText style={[styles.saveLabel, { color: canSave ? theme.onAccent : theme.textSecondary }]}>保存</ThemedText>
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="编辑记录正文"
          autoFocus
          multiline
          onChangeText={setContent}
          placeholder="记录此刻的想法"
          placeholderTextColor={theme.textSecondary}
          selectionColor={theme.accent}
          style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
          textAlignVertical="top"
          value={content}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { minHeight: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.three },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 13 },
  title: { fontSize: 17, lineHeight: 24, fontWeight: '700' },
  titleGroup: { flex: 1, alignItems: 'center', gap: 1 },
  savedAt: { fontSize: 11, lineHeight: 16 },
  saveButton: { minWidth: 64, height: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 13 },
  saveLabel: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  input: { flex: 1, margin: Spacing.three, padding: Spacing.three, borderWidth: 1, borderRadius: 16, fontSize: 17, lineHeight: 26 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
