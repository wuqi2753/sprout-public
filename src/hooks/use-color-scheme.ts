import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useAppTheme } from '@/components/app-theme-provider';

export function useColorScheme() {
  const systemScheme = useSystemColorScheme();
  return useAppTheme()?.colorScheme ?? systemScheme;
}
