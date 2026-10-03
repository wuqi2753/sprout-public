import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type FeedbackDialogProps = {
  visible: boolean;
  title: string;
  message?: string;
  onDismiss: () => void;
};

export function FeedbackDialog({ visible, title, message, onDismiss }: FeedbackDialogProps) {
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
          style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <ThemedText accessibilityRole="header" style={styles.title}>{title}</ThemedText>
          {message ? (
            <ThemedText style={[styles.message, { color: theme.textSecondary }]}>{message}</ThemedText>
          ) : null}
          <Pressable
            accessibilityLabel="确定"
            accessibilityRole="button"
            onPress={onDismiss}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.accent, opacity: pressed ? 0.82 : 1 },
            ]}>
            <ThemedText style={[styles.buttonLabel, { color: theme.onAccent }]}>确定</ThemedText>
          </Pressable>
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
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 20,
    alignItems: 'center',
    elevation: 8,
  },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '700', textAlign: 'center' },
  message: { marginTop: 8, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  button: {
    alignSelf: 'stretch',
    minHeight: 44,
    marginTop: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
});
