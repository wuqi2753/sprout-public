// REQ-047: match the existing new-memo toolbar, with neutral icons.
// REQ-052: image and file actions share five attachment slots.
import { Image } from 'expo-image';
import { Platform, StyleSheet, View } from 'react-native';
import { Pressable } from '@/components/haptic-pressable';
import { useTheme } from '@/hooks/use-theme';

export function MemoEditorToolbar({ disabled, imageCount, fileCount, onTag, onImage, onFile }: {
  disabled: boolean; imageCount: number; fileCount: number;
  onTag: () => void; onImage: () => void; onFile: () => void;
}) {
  const theme = useTheme();
  const actions = [
    { label: '添加标签', source: require('@/assets/icons/tag.svg'), onPress: onTag, disabled },
    { label: `添加图片，附件已选${imageCount + fileCount}个，合计最多5个`, source: require('@/assets/icons/image-attachment.svg'),
      onPress: onImage, disabled: disabled || imageCount + fileCount >= 5 },
    ...(Platform.OS !== 'web' ? [{ label: `添加文件，附件已选${imageCount + fileCount}个，合计最多5个`,
      source: require('@/assets/icons/file-attachment.svg'),
      onPress: onFile, disabled: disabled || imageCount + fileCount >= 5 }] : []),
  ];
  return <View style={[styles.toolbar, { borderTopColor: theme.border }]}>
    {actions.map((action) => <Pressable key={action.label} accessibilityRole="button"
      accessibilityLabel={action.label} accessibilityState={{ disabled: action.disabled }}
      disabled={action.disabled} onPress={action.onPress}
      style={({ pressed }) => [styles.button, { opacity: action.disabled ? 0.35 : 1, backgroundColor: pressed ? theme.backgroundElement : 'transparent' }]}>
      <Image source={action.source} style={styles.image} tintColor={theme.textSecondary} contentFit="contain" accessible={false} />
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  toolbar: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
  button: { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  image: { width: 22, height: 22 },
});
