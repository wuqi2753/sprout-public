// REQ-023: docs/stories/v0.2.0/REQ-023-refine-core-screen-visuals.md
import { SymbolView } from 'expo-symbols';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
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
  type ServerConnectionConfig,
} from '@/api/server-connection';
import {
  getServerConnectionConfig,
  saveServerConnectionConfig,
} from '@/storage/server-connection';

type ConnectionFeedback = { title: string; message?: string; afterDismiss?: () => void };
class ConnectionSetupError extends Error {}

// REQ-016: docs/stories/v0.2.0/REQ-016-server-connection-form.md
export function ServerConnectionForm({ onConnected, onDismiss, initialConnection }: { onConnected?: () => void; onDismiss?: () => void; initialConnection?: ServerConnectionConfig }) {
  const router = useRouter();
  const theme = useTheme();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const connectionPending = useRef(false);
  const connectionSession = useRef(0);
  const [serverApiUrl, setServerApiUrl] = useState(initialConnection?.serverApiUrl ?? '');
  const [apiKey, setApiKey] = useState(initialConnection?.apiKey ?? '');
  const savedConnection = useRef<ServerConnectionConfig | undefined>(undefined);
  const [replacement, setReplacement] = useState<ServerConnectionConfig>();
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<ConnectionFeedback>();
  const formComplete = serverApiUrl.trim().length > 0 && apiKey.trim().length > 0 && !connecting && !saving;

  useEffect(() => {
    const keyboardShowListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true),
    );
    const keyboardHideListener = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { keyboardShowListener.remove(); keyboardHideListener.remove(); };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const session = ++connectionSession.current;
      let active = true;
      getServerConnectionConfig()
        .then((config) => {
          if (!active || !config) return;
          savedConnection.current = config;
          if (!initialConnection) { setServerApiUrl(config.serverApiUrl); setApiKey(config.apiKey); }
        })
        .catch(() => {
          if (active) showError('无法读取已保存的 Server 配置。');
        });
      return () => {
        active = false;
        if (connectionSession.current === session) connectionSession.current++;
      };
    }, [initialConnection]),
  );

  function showError(message: string) {
    setFeedback({ title: '连接失败', message });
  }

  function dismissFeedback() {
    const afterDismiss = feedback?.afterDismiss;
    setFeedback(undefined);
    afterDismiss?.();
  }

  async function verifyConnection(scannedConfig?: ServerConnectionConfig) {
    setConnecting(true);
    try {
      const normalizedServerApiUrl = normalizeServerApiUrl(scannedConfig?.serverApiUrl ?? serverApiUrl);
      const connectionKey = (scannedConfig?.apiKey ?? apiKey).trim();
      await probeServerConnection({ serverApiUrl: normalizedServerApiUrl, apiKey: connectionKey });
      setServerApiUrl(normalizedServerApiUrl);
      return { serverApiUrl: normalizedServerApiUrl, apiKey: connectionKey };
    } catch (error) {
      const message = error instanceof ServerConnectionError ? error.message : '连接 Server 时发生未知错误。';
      if (scannedConfig) throw error instanceof ServerConnectionError ? error : new ConnectionSetupError(message);
      showError(message);
      return undefined;
    } finally {
      setConnecting(false);
    }
  }

  async function verifyConnectionWithFeedback() {
    if (!await verifyConnection()) return;
    setFeedback({ title: '已成功连接' });
  }

  function requestConnection() {
    if (connectionPending.current || connecting || saving) return;
    const previous = savedConnection.current;
    if (previous && (previous.serverApiUrl !== serverApiUrl.trim() || previous.apiKey !== apiKey.trim())) {
      setReplacement({ serverApiUrl: serverApiUrl.trim(), apiKey: apiKey.trim() });
      return;
    }
    void saveConnection();
  }

  async function confirmReplacement() {
    if (!replacement) return;
    const config = replacement;
    setReplacement(undefined);
    try { await saveConnection(config); }
    catch (error) { showError(error instanceof Error ? error.message : '无法连接 Server，请重试。'); }
  }

  // REQ-074: scanned and manually entered credentials use the same save path.
  async function saveConnection(scannedConfig?: ServerConnectionConfig) {
    if (connectionPending.current || connecting) {
      if (scannedConfig) throw new ConnectionSetupError('正在连接，请稍候。');
      return;
    }
    connectionPending.current = true;
    const session = connectionSession.current;
    setSaving(true);
    try {
      if (scannedConfig) {
        setServerApiUrl(scannedConfig.serverApiUrl);
        setApiKey(scannedConfig.apiKey);
      }
      const verifiedConfig = await verifyConnection(scannedConfig);
      if (!verifiedConfig) return;
      if (connectionSession.current !== session) throw new ConnectionSetupError('连接页面已关闭，请重新连接。');
      await saveServerConnectionConfig(verifiedConfig);
      try {
        await initializeWelcomeMemo();
      } catch {
        if (scannedConfig) throw new ConnectionSetupError('无法创建欢迎笔记，请关闭扫码后重试连接。');
        showError('无法创建欢迎笔记，请再次点击连接服务器重试。');
        return;
      }
      if (connectionSession.current !== session) return;
      Keyboard.dismiss();
      if (onConnected) onConnected();
      else router.replace('/');
    } catch (error) {
      if (scannedConfig) throw new Error(error instanceof ServerConnectionError || error instanceof ConnectionSetupError ? error.message : '无法安全保存 Server 配置，请重试。');
      showError('无法安全保存 Server 配置。');
    } finally {
      connectionPending.current = false;
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
          {(onDismiss || !onConnected) && <Pressable
            accessibilityLabel={onDismiss ? '关闭连接配置' : '返回'}
            accessibilityRole="button"
            onPress={onDismiss ?? (() => router.canGoBack() ? router.back() : router.replace('/'))}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'xmark', android: 'close', web: 'close' }}
              size={24}
              tintColor={theme.textSecondary}
            />
          </Pressable>}
        </View>

        <View style={[styles.pageContent, styles.manualPageContent, keyboardVisible && styles.keyboardContent]}>
          <View style={[styles.contentColumn, styles.manualColumn]}>
            {!keyboardVisible && <View style={[styles.intro, styles.compactIntro, styles.manualIntro]}>
              <ThemedText style={styles.manualTitle}>
                嗨，<ThemedText style={[styles.manualTitle, { color: theme.accent }]}>开始记录</ThemedText>
              </ThemedText>
              <ThemedText style={[styles.description, styles.manualDescription]} themeColor="textSecondary">
                连接你自己的 Server{'\n'}让想法保存在自己手中
              </ThemedText>
            </View>}

            <View>
            {<>
            <View style={styles.formCard}>
              <View style={styles.fieldGroup}>
                <ThemedText style={styles.fieldLabel}>服务器 API 地址</ThemedText>
                <TextInput
                  accessibilityLabel="服务器 API 地址"
                  editable={!connecting && !saving}
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
                  editable={!connecting && !saving}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setApiKey}
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
                onPress={requestConnection}
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

            </>}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <FeedbackDialog visible={replacement !== undefined} title="更换服务器？" message={replacement ? `将连接到 ${replacement.serverApiUrl}。验证成功后保存新连接，现有本地笔记保留。` : undefined} onDismiss={() => setReplacement(undefined)} destructiveAction={{ label: '确认连接', onPress: () => { void confirmReplacement(); } }} />
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
  header: { paddingHorizontal: 16, paddingTop: 4, minHeight: 52 },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  pageContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, paddingBottom: 88 },
  keyboardContent: { paddingBottom: 8 },
  manualPageContent: { justifyContent: 'flex-start', paddingHorizontal: 24, paddingBottom: 32 },
  manualColumn: { maxWidth: 420 },
  manualIntro: { paddingTop: 32, paddingBottom: 40 },
  manualTitle: { fontSize: 32, lineHeight: 44, fontWeight: '400' },
  manualDescription: { marginTop: 24, fontSize: 16, lineHeight: 28, fontWeight: '400', opacity: 1 },
  contentColumn: { width: '100%', maxWidth: 340 },
  intro: { paddingBottom: 36 },
  compactIntro: { paddingBottom: 20 },
  title: { fontSize: 26, lineHeight: 36, fontWeight: '500', letterSpacing: -0.3 },
  description: { marginTop: 12, fontSize: 14, lineHeight: 24, fontWeight: '400', opacity: 0.8 },
  scanHint: { marginBottom: 12, fontSize: 12, lineHeight: 18, fontWeight: '400', opacity: 0.7 },
  manualButton: { minHeight: 44, marginTop: 8, marginBottom: 8, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  manualLabel: { fontSize: 13, lineHeight: 20, fontWeight: '400' },
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
