/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#20211F',
    background: '#F8F8F6',
    surface: '#FDFDFC',
    backgroundElement: '#F0F0ED',
    backgroundSelected: '#E2E3DF',
    textSecondary: '#6C6F69',
    border: '#D9DAD5',
    accent: '#24CB78',
    accentMuted: '#E0F6EA',
    tag: '#1677C8',
    tagBackground: '#E2EAF4',
    onAccent: '#153524',
    danger: '#B42318',
  },
  dark: {
    text: '#ECEDE9',
    background: '#171815',
    surface: '#1D1F1B',
    backgroundElement: '#242620',
    backgroundSelected: '#34372F',
    textSecondary: '#A4A89F',
    border: '#393C34',
    accent: '#35D78A',
    accentMuted: '#203D2D',
    tag: '#58A6E7',
    tagBackground: '#34445D',
    onAccent: '#153524',
    danger: '#FF8A80',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
