// REQ-046: Persist the theme using the existing native storage dependency.
import * as SecureStore from 'expo-secure-store';

export type ThemePreference = 'light' | 'dark';
const THEME_KEY = 'sprout.theme-preference';

function readThemePreference(value: string | null): ThemePreference | undefined {
  if (value === null) return undefined;
  if (value !== 'light' && value !== 'dark') throw new Error('Stored theme preference must be light or dark');
  return value;
}

export async function getThemePreference() {
  return readThemePreference(await SecureStore.getItemAsync(THEME_KEY));
}

export async function saveThemePreference(preference: ThemePreference) {
  readThemePreference(preference);
  await SecureStore.setItemAsync(THEME_KEY, preference);
}
