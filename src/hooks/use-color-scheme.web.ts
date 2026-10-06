import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';
import { useAppTheme } from '@/components/app-theme-provider';

const subscribeToHydration = () => () => {};

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );

  const colorScheme = useRNColorScheme();
  const appTheme = useAppTheme();

  if (hasHydrated) {
    return appTheme?.colorScheme ?? colorScheme;
  }

  return appTheme?.colorScheme ?? 'dark';
}
