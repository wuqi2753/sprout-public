// REQ-040 / REQ-041
import { StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import type { FileAttachment } from '@/types/attachment';
import { FileTypeIcon } from '@/components/file-type-icon';

export function FileAttachmentCard({ attachment, onRemove, onOpen }: { attachment: FileAttachment; onRemove?: () => void; onOpen?: () => void }) {
  const theme = useTheme();
  const size = attachment.size < 1024 * 1024
    ? `${Math.ceil(attachment.size / 1024)} KB`
    : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;
  return <View style={[styles.card, { backgroundColor: theme.fileBackground, borderColor: theme.fileBorder }]}>
    <FileTypeIcon name={attachment.name} />
    <View style={styles.labels}>
      <ThemedText numberOfLines={2} style={styles.name}>{attachment.name}</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.metadata}>{attachment.name.split('.').at(-1)?.toUpperCase()} · {size}</ThemedText>
    </View>
    {onRemove && <Pressable accessibilityLabel="移除待添加文件" accessibilityRole="button" onPress={onRemove}
      style={({ pressed }) => [styles.remove, pressed && { opacity: 0.6 }]}>
      <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={20} tintColor={theme.text} />
    </Pressable>}
    {onOpen && <Pressable accessibilityLabel={`查看文件 ${attachment.name}`} accessibilityRole="button" onPress={onOpen}
      style={({ pressed }) => [styles.remove, pressed && { opacity: 0.6 }]}>
      <ThemedText style={{ color: theme.accent, fontSize: 14 }}>查看</ThemedText>
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 8, marginTop: 8 },
  labels: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, lineHeight: 20 },
  metadata: { fontSize: 12, lineHeight: 18 },
  remove: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
