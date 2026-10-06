import { Caveat_600SemiBold } from '@expo-google-fonts/caveat/600SemiBold';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname } from 'expo-router';
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { AppThemeProvider, useAppTheme } from '@/components/app-theme-provider';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useHiddenMemoLifecycle } from '@/hooks/use-hidden-memo-access';
import { hiddenMemoSession } from '@/auth/hidden-memo-session';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return <AppThemeProvider><RootLayoutContent /></AppThemeProvider>;
}

function RootLayoutContent() {
  useHiddenMemoLifecycle();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname !== '/' && !pathname.startsWith('/memo/')) hiddenMemoSession.lock();
  }, [pathname]);
  const colorScheme = useColorScheme();
  const themeReady = useAppTheme()?.ready;
  const [fontsLoaded, fontError] = useFonts({ Caveat_600SemiBold });

  if (fontError) throw fontError;
  if (!fontsLoaded || !themeReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={() => SplashScreen.hide()}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="explore" />
          <Stack.Screen name="memo/[id]" />
          <Stack.Screen name="server-connection" />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
