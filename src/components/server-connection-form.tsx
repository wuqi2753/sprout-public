// REQ-023: docs/stories/v0.2.0/REQ-023-refine-core-screen-visuals.md
import { SymbolView } from 'expo-symbols';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Pressable } from '@/components/haptic-pressable';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { initializeWelcomeMemo } from '@/storage/memos';
import {
  normalizeServerApiUrl,
  probeServerConnection,
  ServerConnectionError,
} from '@/api/server-connection';
import {
  getServerConnectionConfig,
  saveServerConnectionConfig,
} from '@/storage/server-connection';

type ConnectionFeedback = { title: string; message?: string; afterDismiss?: () => void };

// REQ-016: docs/stories/v0.2.0/REQ-016-server-connection-form.md
export function ServerConnectionForm({ onConnected }: { onConnected?: () => void }) {
  const router = useRouter();
  const theme = useTheme();
  const scrollViewRef = useRef<ScrollView>(null);
  const apiKeyFocused = useRef(false);
  const [serverApiUrl, setServerApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<ConnectionFeedback>();
  const formComplete = serverApiUrl.trim().length > 0 && apiKey.trim().length > 0 && !connecting && !saving;

  useEffect(() => {
    const keyboardListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => {
        if (apiKeyFocused.current) {
          scrollViewRef.current?.scrollToEnd({ animated: true });
        }
      },
    );
    return () => keyboardListener.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      getServerConnectionConfig()
        .then((config) => {
          if (!active || !config) return;
          setServerApiUrl(config.serverApiUrl);
          setApiKey(config.apiKey);
        })
        .catch(() => {
          if (active) showError('无法读取已保存的 Server 配置。');
        });
      return () => {
        active = false;
      };
    }, []),
  );

  function showError(message: string) {
    setFeedback({ title: '连接失败', message });
  }

  function dismissFeedback() {
    const afterDismiss = feedback?.afterDismiss;
    setFeedback(undefined);
    afterDismiss?.();
  }

  async function verifyConnection() {
    setConnecting(true);
    try {
      const normalizedServerApiUrl = normalizeServerApiUrl(serverApiUrl);
      await probeServerConnection({ serverApiUrl: normalizedServerApiUrl, apiKey });
      setServerApiUrl(normalizedServerApiUrl);
      return { serverApiUrl: normalizedServerApiUrl, apiKey: apiKey.trim() };
    } catch (error) {
      showError(error instanceof ServerConnectionError ? error.message : '连接 Server 时发生未知错误。');
      return undefined;
    } finally {
      setConnecting(false);
    }
  }

  async function verifyConnectionWithFeedback() {
    if (!await verifyConnection()) return;
    setFeedback({ title: '已成功连接' });
  }

  async function saveConnection() {
    setSaving(true);
    try {
      const verifiedConfig = await verifyConnection();
      if (!verifiedConfig) return;
      await saveServerConnectionConfig(verifiedConfig);
      try {
        await initializeWelcomeMemo();
      } catch {
        showError('无法创建欢迎笔记，请再次点击连接服务器重试。');
        return;
      }
      Keyboard.dismiss();
      if (onConnected) onConnected();
      else router.replace('/');
    } catch {
      showError('无法安全保存 Server 配置。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.screen}>
        <View style={styles.header}>
          {!onConnected && <Pressable
            accessibilityLabel="返回"
            accessibilityRole="button"
            onPress={() => router.canGoBack() ? router.back() : router.replace('/')}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'xmark', android: 'close', web: 'close' }}
              size={24}
              tintColor={theme.textSecondary}
            />
          </Pressable>}
        </View>

        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.scrollContent}
          keyboardDismissMode="none"
          keyboardShouldPersistTaps="handled">
          <View style={styles.contentColumn}>
            <View style={styles.intro}>
              <ThemedText style={styles.title}>
                嗨，<ThemedText style={[styles.title, { color: theme.accent }]}>开始记录</ThemedText>
              </ThemedText>
              <ThemedText style={styles.description} themeColor="textSecondary">
                记下一闪而过的想法{'\n'}保存在你自己的服务器
              </ThemedText>
            </View>

            <View style={styles.formCard}>
              <View style={styles.fieldGroup}>
                <ThemedText style={styles.fieldLabel}>服务器 API 地址</ThemedText>
                <TextInput
                  accessibilityLabel="服务器 API 地址"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={setServerApiUrl}
                  placeholder="https://memo.example.com"
                  placeholderTextColor={theme.connectionPlaceholder}
                  selectionColor={theme.accent}
                  style={[
                    styles.input,
                    { backgroundColor: theme.backgroundElement, color: theme.text },
                  ]}
                  value={serverApiUrl}
                />
              </View>

              <View style={styles.fieldGroup}>
                <ThemedText style={styles.fieldLabel}>API Key</ThemedText>
                <TextInput
                  accessibilityLabel="API Key"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onBlur={() => { apiKeyFocused.current = false; }}
                  onChangeText={setApiKey}
                  onFocus={() => { apiKeyFocused.current = true; }}
                  placeholder="输入 API Key"
                  placeholderTextColor={theme.connectionPlaceholder}
                  secureTextEntry
                  selectionColor={theme.accent}
                  style={[
                    styles.input,
                    { backgroundColor: theme.backgroundElement, color: theme.text },
                  ]}
                  value={apiKey}
                />
              </View>
            </View>

            <View style={styles.actions}>
              <Pressable
                accessibilityLabel="连接服务器"
                accessibilityRole="button"
                accessibilityState={{ disabled: !formComplete, busy: connecting || saving }}
                disabled={!formComplete}
                onPress={saveConnection}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: theme.accent, opacity: formComplete ? 1 : 0.5 },
                  pressed && styles.pressed,
                ]}>
                {(connecting || saving) && <ActivityIndicator color={theme.onAccent} size="small" />}
                <ThemedText style={[styles.primaryButtonLabel, { color: theme.onAccent }]}>
                  {saving ? '连接中…' : '连接服务器'}
                </ThemedText>
              </Pressable>
              <Pressable
                accessibilityLabel="验证连接"
                accessibilityRole="button"
                accessibilityState={{ disabled: !formComplete }}
                disabled={!formComplete}
                onPress={verifyConnectionWithFeedback}
                style={({ pressed }) => [styles.secondaryButton, styles.verifyButton, { borderColor: theme.border, backgroundColor: theme.surface, opacity: formComplete ? 1 : 0.5 }, pressed && styles.pressed]}>
                <ThemedText style={styles.secondaryButtonLabel}>
                  {connecting && !saving ? '验证中…' : '验证连接'}
                </ThemedText>
              </Pressable>
            </View>

          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <FeedbackDialog
        message={feedback?.message}
        onDismiss={dismissFeedback}
        title={feedback?.title ?? ''}
        visible={feedback !== undefined}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 12, paddingTop: 4 },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 24, paddingBottom: 32 },
  contentColumn: { width: '100%', maxWidth: 420 },
  intro: { paddingTop: 32, paddingBottom: 40 },
  title: { fontSize: 32, lineHeight: 44, fontWeight: '400' },
  description: { marginTop: 24, fontSize: 16, lineHeight: 28, fontWeight: '400' },
  formCard: { gap: 20 },
  fieldGroup: { gap: 8 },
  fieldLabel: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
  input: { minHeight: 52, paddingVertical: 14, borderRadius: 14, paddingHorizontal: 16, fontSize: 16 },
  actions: { marginTop: 24, gap: 12 },
  secondaryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  verifyButton: { borderWidth: 1, borderRadius: 14, minHeight: 52 },
  secondaryButtonLabel: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  primaryButton: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, gap: 8, flexDirection: 'row', borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  primaryButtonLabel: { fontSize: 17, lineHeight: 26, fontWeight: '600' },
  pressed: { opacity: 0.72 },
});
