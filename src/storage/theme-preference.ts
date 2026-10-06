// REQ-046: Web theme preference only; no Server communication.
export type ThemePreference = 'light' | 'dark';
const THEME_KEY = 'sprout.theme-preference';

export function readThemePreference(value: string | null): ThemePreference | undefined {
  if (value === null) return undefined;
  if (value !== 'light' && value !== 'dark') throw new Error('Stored theme preference must be light or dark');
  return value;
}

export async function getThemePreference() {
  if (typeof window === 'undefined') return undefined;
  return readThemePreference(window.localStorage.getItem(THEME_KEY));
}

export async function saveThemePreference(preference: ThemePreference) {
  readThemePreference(preference);
  window.localStorage.setItem(THEME_KEY, preference);
}
