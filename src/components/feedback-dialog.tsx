// REQ-022: docs/stories/v0.2.0/REQ-022-unified-feedback-dialog.md
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type FeedbackDialogProps = {
  visible: boolean;
  title: string;
  message?: string;
  onDismiss: () => void;
  destructiveAction?: { label: string; onPress: () => void };
};

export function FeedbackDialog({ visible, title, message, onDismiss, destructiveAction }: FeedbackDialogProps) {
  const theme = useTheme();

  return (
    <Modal
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View style={styles.overlay}>
        <View
          accessibilityViewIsModal
          style={[styles.card, { backgroundColor: theme.surface }]}>
          <ScrollView style={styles.content}>
            <ThemedText accessibilityRole="header" style={styles.title}>{title}</ThemedText>
            {message ? (
              <ThemedText style={[styles.message, { color: theme.textSecondary }]}>{message}</ThemedText>
            ) : null}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable
              accessibilityLabel={destructiveAction ? '取消' : '确定'}
              accessibilityRole="button"
              onPress={onDismiss}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: pressed ? theme.backgroundElement : 'transparent' },
              ]}>
              <ThemedText style={[styles.buttonLabel, { color: destructiveAction ? theme.textSecondary : theme.accent }]}>{destructiveAction ? '取消' : '确定'}</ThemedText>
            </Pressable>
            {destructiveAction && <Pressable accessibilityRole="button" accessibilityLabel={destructiveAction.label}
              onPress={destructiveAction.onPress} style={({ pressed }) => [styles.button, { backgroundColor: pressed ? theme.backgroundElement : 'transparent' }]}>
              <ThemedText style={[styles.buttonLabel, { color: theme.danger }]}>{destructiveAction.label}</ThemedText>
            </Pressable>}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
  },
  card: {
    width: '100%',
    maxWidth: 320,
    maxHeight: '80%',
    borderRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 12,
    elevation: 4,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
  },
  content: { flexGrow: 0, flexShrink: 1 },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '500', textAlign: 'left' },
  message: { marginTop: 12, fontSize: 14, lineHeight: 22, fontWeight: '400', textAlign: 'left' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 20, marginRight: -12 },
  button: {
    minWidth: 64,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
});
