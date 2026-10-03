import * as Haptics from 'expo-haptics';
import { Platform, Pressable as NativePressable, type PressableProps } from 'react-native';

export function Pressable({ onPress, ...pressableProps }: PressableProps) {
  return (
    <NativePressable
      {...pressableProps}
      onPress={
        onPress
          ? (event) => {
              if (Platform.OS === 'android') {
                Haptics.selectionAsync().catch((error) => {
                  console.warn('Unable to perform button haptic feedback', error);
                });
              }
              onPress(event);
            }
          : undefined
      }
    />
  );
}
