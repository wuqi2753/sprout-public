/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

// REQ-046: Claude color tokens converted from OKLCH to native-compatible sRGB.
export const Colors = {
  light: {
    text: "#3D3929",
    background: "#FAF9F5",
    surface: "#FAF9F5",
    backgroundElement: "#EDE9DE",
    tagDragBackground: "#E7E6E2",
    backgroundSelected: "#E9E6DC",
    textSecondary: "#83827D",
    connectionPlaceholder: "#AAA8A1",
    memoStatisticsText: "#9D9D9D",
    growthTotalText: "#9D9D9D",
    heatmapLevel1: "#F2DCD0",
    heatmapLevel2: "#E6B59E",
    heatmapLevel3: "#D99170",
    recordingGrowthIncrease: "#B55F43",
    sidebarTagHeading: "#B55F43",
    sidebarSelectedBackground: "#E9E6DC",
    sidebarSelectedText: "#C96442",
    sidebarSelectedCount: "#83827D",
    border: "#DAD9D4",
    accent: "#C96442",
    deletionUndoText: "#9C4D34",
    accentMuted: "#E9E6DC",
    tag: "#28261B",
    tagBackground: "#E9E6DC",
    onAccent: "#FFFFFF",
    danger: "#141413",
    fileSpreadsheet: "#42745B",
    filePdf: "#AE5145",
    fileBackground: 'rgba(61, 57, 41, 0.035)',
    fileBorder: 'rgba(61, 57, 41, 0.12)',
    captureText: '#68665F',
    captureBackground: '#FAF9F5',
    captureBorder: '#DAD9D4',
    unsyncedBackground: '#EDE9DE',
  },
  dark: {
    text: "#C3C0B6",
    background: "#262624",
    surface: "#262624",
    backgroundElement: "#1B1B19",
    tagDragBackground: "#3B3B38",
    backgroundSelected: "#1A1915",
    textSecondary: "#B7B5A9",
    connectionPlaceholder: "#797870",
    memoStatisticsText: "#B7B5A9",
    growthTotalText: "#929087",
    heatmapLevel1: "#44352D",
    heatmapLevel2: "#76503D",
    heatmapLevel3: "#AA7052",
    recordingGrowthIncrease: "#E6BDA8",
    sidebarTagHeading: "#E6BDA8",
    sidebarSelectedBackground: "#D97757",
    sidebarSelectedText: "#C3C0B6",
    sidebarSelectedCount: "#C3C0B6",
    border: "#3E3E38",
    accent: "#D97757",
    deletionUndoText: "#D97757",
    accentMuted: "#FAF9F5",
    tag: "#E6B49C",
    tagBackground: "#40332D",
    onAccent: "#FFFFFF",
    danger: "#EF4444",
    fileSpreadsheet: "#91B59B",
    filePdf: "#DB9685",
    fileBackground: 'rgba(245, 244, 238, 0.015)',
    fileBorder: 'rgba(245, 244, 238, 0.10)',
    captureText: '#C3C0B6',
    captureBackground: '#2A2A27',
    captureBorder: 'rgba(195, 192, 182, 0.16)',
    unsyncedBackground: 'rgba(195, 192, 182, 0.045)',
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
