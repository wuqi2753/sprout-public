// REQ-049: docs/stories/v0.2.0/REQ-049-file-name-actions.md
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, TextInput, View } from 'react-native';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export function FileNameActions({ name, onDismiss, onOpen, onRename }: {
  name: string; onDismiss: () => void; onOpen: () => void; onRename: (stem: string) => Promise<void>;
}) {
  const theme = useTheme();
  const [renaming, setRenaming] = useState(false);
  const [stem, setStem] = useState(name.slice(0, name.lastIndexOf('.')));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const extension = name.slice(name.lastIndexOf('.'));
  async function saveName() {
    if (saving) return;
    setSaving(true);
    setError('');
    try { await onRename(stem); onDismiss(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '重命名失败，请重试。'); }
    finally { setSaving(false); }
  }
  return <Modal transparent visible animationType="fade" onRequestClose={() => { if (!saving) onDismiss(); }}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
      <Pressable accessibilityLabel="关闭文件操作" accessibilityRole="button" disabled={saving} onPress={onDismiss} style={StyleSheet.absoluteFill} />
      <View accessibilityViewIsModal style={[styles.window, !renaming && styles.menuWindow, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        {renaming ? <>
          <ThemedText themeColor="textSecondary" style={styles.hint}>文件名称</ThemedText>
          <TextInput autoFocus accessibilityLabel="文件名称" editable={!saving} value={stem} onChangeText={setStem}
            selectionColor={theme.accent} style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]} />
          <ThemedText themeColor="textSecondary" style={styles.hint}>保留 {extension} 扩展名</ThemedText>
          {error ? <ThemedText accessibilityRole="alert" style={[styles.hint, { color: theme.danger }]}>{error}</ThemedText> : null}
          <Pressable accessibilityRole="button" disabled={saving || !stem.trim()} accessibilityState={{ disabled: saving || !stem.trim() }} onPress={() => { void saveName(); }}
            style={({ pressed }) => [styles.action, { backgroundColor: theme.backgroundElement, opacity: saving || !stem.trim() ? 0.4 : pressed ? 0.6 : 1 }]}>
            <ThemedText style={styles.actionLabel}>{saving ? '正在保存…' : '保存'}</ThemedText>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={saving} onPress={onDismiss} style={styles.action}><ThemedText themeColor="textSecondary">取消</ThemedText></Pressable>
        </> : <>
          <Pressable accessibilityRole="button" disabled={saving} onPress={onOpen} style={({ pressed }) => [styles.action, styles.menuAction, { backgroundColor: pressed ? theme.backgroundElement : 'transparent' }]}>
            <ThemedText style={styles.menuLabel}>查看</ThemedText>
          </Pressable>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={[styles.divider, { backgroundColor: theme.border }]} />
          <Pressable accessibilityRole="button" disabled={saving} onPress={() => { setError(''); setRenaming(true); }} style={({ pressed }) => [styles.action, styles.menuAction, { backgroundColor: pressed ? theme.backgroundElement : 'transparent' }]}>
            <ThemedText style={styles.menuLabel}>重命名</ThemedText>
          </Pressable>
          {error ? <ThemedText accessibilityRole="alert" style={[styles.hint, { color: theme.danger }]}>{error}</ThemedText> : null}
        </>}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.32)' },
  window: { width: '100%', maxWidth: 360, padding: 16, gap: 8, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth },
  menuWindow: { maxWidth: 280, padding: 8, gap: 0, borderRadius: 16 },
  menuAction: { flexDirection: 'row', justifyContent: 'flex-start', paddingHorizontal: 16, paddingVertical: 16, minHeight: 56, borderRadius: 8 },
  menuLabel: { flexShrink: 1, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, marginVertical: 4 },
  actionLabel: { fontSize: 15, lineHeight: 22, fontWeight: '500' },
  action: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
  hint: { fontSize: 13, lineHeight: 20 },
});
