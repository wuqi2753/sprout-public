import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type MemoSyncStatusProps = {
  synced: boolean;
};

export function MemoSyncStatus({ synced }: MemoSyncStatusProps) {
  const theme = useTheme();

  if (synced) return null;

  return (
    <View
      accessibilityLabel="未同步"
      style={[styles.unsyncedBadge, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText style={styles.label} themeColor="textSecondary">
        未同步
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 10, lineHeight: 14, fontWeight: '500' },
  unsyncedBadge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
});
