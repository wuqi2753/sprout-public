// REQ-072: docs/stories/v0.2.0/REQ-072-scan-server-connection.md
import { useFocusEffect } from "expo-router";
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SymbolView } from 'expo-symbols';
import Svg, { Path } from 'react-native-svg';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { parseServerQr, validateQrConnection, type ServerQr } from '@/api/server-qr';
import { requestCliApproval, cliRequestStatusMessage, type CliDeviceRequest } from '@/api/cli-device-approval';
import { getServerConnectionConfig } from '@/storage/server-connection';
import type { ServerConnectionConfig } from '@/api/server-connection';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

// REQ-074: confirm before supplying scanned credentials to the connection form.
export function ServerQrScanner({ onClose, serverUrl, connected = false, allowPairing = false, onConnect, onManualEntry, onServerSettings, onReadConnection }: {
  onClose: () => void; serverUrl?: string; connected?: boolean; allowPairing?: boolean;
  onConnect?: (config: ServerConnectionConfig) => Promise<void>; onManualEntry?: () => void;
  onServerSettings?: () => void;
  onReadConnection?: (config: ServerConnectionConfig) => void;
}) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [focused, setFocused] = useState(true);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [qr, setQr] = useState<ServerQr>();
  const [message, setMessage] = useState<string>();
  const scanLocked = useRef(false);
  const confirmationPending = useRef(false);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  // REQ-096: only an explicit user decision may approve a verified request.
  const [cliRequest, setCliRequest] = useState<CliDeviceRequest>();
  const cliDecisionVisible = qr?.type === 'cli' && cliRequest?.status === 'pending' && !message;
  const approvalConnection = useRef<ServerConnectionConfig | undefined>(undefined);
  const approvalController = useRef<AbortController | undefined>(undefined);
  const liveServer = useRef({ serverUrl, connected });
  useEffect(() => { liveServer.current = { serverUrl, connected }; }, [serverUrl, connected]);
  const mounted = useRef(true);
  const approvalGeneration = useRef(0);
  const decisionNeedsQuery = useRef(false);
  function cancelApproval() {
    approvalGeneration.current += 1;
    approvalController.current?.abort();
    confirmationPending.current = false;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelApproval(); }; }, []);
  useEffect(() => {
    if (!foreground || !focused) {
      cancelApproval();
      queueMicrotask(() => {
        if (!mounted.current) return;
        setConnecting(false);
        if (scanLocked.current) { setCliRequest(undefined); setMessage('操作已暂停，请重新查询或扫描。'); }
      });
    }
  }, [foreground, focused]);
  useEffect(() => {
    if (approvalConnection.current && (approvalConnection.current.serverApiUrl !== serverUrl || !connected)) {
      cancelApproval();
      queueMicrotask(() => {
        if (!mounted.current) return;
        setConnecting(false); setCliRequest(undefined); setMessage('Server 连接已变化，请重新扫描。');
      });
    }
  }, [serverUrl, connected]);
  async function queryOrDecide(scanned: Extract<ServerQr, { type: 'cli' }>, decision?: 'approve' | 'deny') {
    if (confirmationPending.current) return;
    confirmationPending.current = true;
    const generation = ++approvalGeneration.current;
    const controller = new AbortController();
    approvalController.current = controller;
    setConnecting(true);
    const current = () => mounted.current && generation === approvalGeneration.current && !controller.signal.aborted;
    try {
      const config = await getServerConnectionConfig();
      if (!current()) return;
      if (!config) throw new Error('请先连接你的 Server。');
      validateQrConnection(scanned, config.serverApiUrl, liveServer.current.connected, false);
      if (config.serverApiUrl !== liveServer.current.serverUrl || (approvalConnection.current && (config.serverApiUrl !== approvalConnection.current.serverApiUrl || config.apiKey !== approvalConnection.current.apiKey))) throw new Error('Server 连接已变化，请重新扫描。');
      approvalConnection.current = config;
      if (decision && (!cliRequest || cliRequestStatusMessage(cliRequest) || decisionNeedsQuery.current)) throw new Error('请先重新查询申请状态。');
      const request = await requestCliApproval(config, scanned.userCode, controller.signal, decision);
      const saved = await getServerConnectionConfig();
      if (!current()) return;
      if (!saved || saved.serverApiUrl !== config.serverApiUrl || saved.apiKey !== config.apiKey || liveServer.current.serverUrl !== config.serverApiUrl) throw new Error('Server 连接已变化，请重新扫描。');
      decisionNeedsQuery.current = false;
      setCliRequest(request);
      setMessage(cliRequestStatusMessage(request));
    } catch (error) {
      if (!current()) return;
      if (decision) decisionNeedsQuery.current = true;
      setCliRequest(undefined);
      setMessage(error instanceof Error ? error.message : '无法读取授权申请。');
    } finally {
      if (current()) { confirmationPending.current = false; setConnecting(false); }
    }
  }
  function scan(encoded: string) {
    if (scanLocked.current) return;
    scanLocked.current = true;
    try {
      const scanned = parseServerQr(encoded);
      validateQrConnection(scanned, serverUrl, connected, allowPairing);
      if (scanned.type === 'pairing' && typeof onReadConnection === 'function') {
        onReadConnection({ serverApiUrl: scanned.serverUrl, apiKey: scanned.apiKey });
        return;
      }
      setQr(scanned);
      if (scanned.type === 'cli') void queryOrDecide(scanned);
    } catch (error) { setMessage(error instanceof Error ? error.message : '无法读取二维码。'); }
  }
  function rescan() { cancelApproval(); setConnecting(false); setQr(undefined); setCliRequest(undefined); approvalConnection.current = undefined; decisionNeedsQuery.current = false; setMessage(undefined); scanLocked.current = false; }
  async function enableCamera() {
    try {
      if (permission?.canAskAgain === false) await Linking.openSettings();
      else await requestPermission();
    } catch { setMessage('无法打开相机权限，请在系统设置中允许相机访问。'); }
  }
  async function confirmScan() {
    if (!qr || confirmationPending.current) return;
    confirmationPending.current = true;
    setConnecting(true);
    try {
      validateQrConnection(qr, serverUrl, connected, allowPairing);
      if (qr.type === 'pairing') {
        if (!onConnect) throw new Error('请到服务器设置连接此 Server。');
        await onConnect({ serverApiUrl: qr.serverUrl, apiKey: qr.apiKey });
        onClose();
      } else {
        throw new Error('CLI 申请应通过审批按钮提交。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法连接 Server，请重试。');
    } finally {
      setQr(undefined);
      confirmationPending.current = false;
      setConnecting(false);
    }
  }
  return <Modal visible animationType="slide" onRequestClose={() => { if (!confirmationPending.current) onClose(); }}>
    <View style={styles.screen}>
      {permission?.granted && foreground && focused && !qr && !message ? <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scan(data)} onMountError={() => { scanLocked.current = true; setMessage('相机启动失败，请关闭后重试。'); }} /> : null}
      <SafeAreaView style={styles.content}>
      <View style={styles.header}>
        <View pointerEvents="none" style={styles.headerTitle}><ThemedText style={styles.headerTitleText}>扫描二维码</ThemedText></View>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" accessibilityState={{ disabled: connecting }} disabled={connecting} onPress={onClose} style={({ pressed }) => [styles.backButton, { opacity: connecting ? 0.5 : pressed ? 0.7 : 1 }]}>
          <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back_ios_new', web: 'arrow_back_ios_new' }} size={22} tintColor="#FFFFFF" />
        </Pressable>
      </View>
      <View style={styles.preview}>
        {!permission?.granted && !qr && !message && <View style={styles.permission}><ThemedText style={styles.cameraText}>{permission ? '需要相机权限来扫描二维码' : '正在读取相机权限…'}</ThemedText>{permission && <ScanButton label={permission.canAskAgain ? '允许使用相机' : '打开系统设置'} onPress={() => { void enableCamera(); }} primary />}</View>}
        {!foreground && permission?.granted && !qr && !message && <ThemedText style={styles.cameraText}>返回 App 后继续扫描</ThemedText>}
        {!qr && !message && permission?.granted && foreground && <View pointerEvents="none" style={styles.frame}>
          <View style={[styles.corner, styles.topLeft]} /><View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} /><View style={[styles.corner, styles.bottomRight]} />
        </View>}
      </View>
      {onServerSettings && !qr && !message && <View style={styles.footer}>
        <Pressable accessibilityRole="button" accessibilityLabel="我的服务器" accessibilityState={{ disabled: connecting }} disabled={connecting} onPress={onServerSettings} style={({ pressed }) => [styles.serverButton, { opacity: connecting ? 0.5 : pressed ? 0.7 : 1 }]}>
          <View style={styles.serverIcon}><Svg width={28} height={28} viewBox="0 0 1024 1024" accessible={false}>
            <Path d="M128 608h768v192H128v-192z m0-256h768v192H128v-192z m32-140.8h704l28.8 73.6H131.2L160 211.2zM131.2 160L64 284.8V864h896V284.8L896 160H131.2z" fill="#FFFFFF" />
            <Path d="M768 416h64v64h-64zM768 672h64v64h-64z" fill="#FFFFFF" />
          </Svg></View>
          <ThemedText style={styles.serverLabel}>我的服务器</ThemedText>
        </Pressable>
      </View>}
      {(qr || message) && <View style={styles.overlay}><View accessibilityViewIsModal style={[styles.card, { backgroundColor: theme.surface }]}><ScrollView style={{ flexGrow: 0, flexShrink: 1 }}>
        <ThemedText accessibilityRole="header" style={styles.title}>{message ? '扫码提示' : qr?.type === 'pairing' ? '连接此 Server？' : '允许 CLI 连接？'}</ThemedText>
        <ThemedText style={styles.details}>{message ?? (qr?.type === 'pairing' ? `${serverUrl ? '将更换当前连接。\n' : ''}${qr.serverUrl}\n请确认这是你自己的 Server。` : cliRequest ? `核对码：${cliRequest.userCode}` : '正在查询申请…')}</ThemedText>
        </ScrollView>
        <View style={styles.actions}>
          {!cliDecisionVisible && <ScanButton label="关闭" onPress={onClose} disabled={connecting} />}
          {message && qr?.type === 'cli' && cliRequest?.status !== 'approved' && cliRequest?.status !== 'consumed' && <ScanButton label={connecting ? '查询中…' : '重新查询'} onPress={() => { void queryOrDecide(qr); }} disabled={connecting} />}
          {message && cliRequest?.status !== 'approved' && cliRequest?.status !== 'consumed' && <ScanButton label="重新扫描" onPress={rescan} disabled={connecting} primary />}
          {message && onManualEntry && cliRequest?.status !== 'approved' && cliRequest?.status !== 'consumed' && <ScanButton label="手动填写" onPress={onManualEntry} disabled={connecting} />}
          {cliDecisionVisible && qr?.type === 'cli' && <>
            <ScanButton label="拒绝" onPress={() => { void queryOrDecide(qr, 'deny'); }} disabled={connecting} />
            <ScanButton label={connecting ? '处理中…' : '允许'} onPress={() => { void queryOrDecide(qr, 'approve'); }} disabled={connecting} primary />
          </>}
          {qr?.type === 'pairing' && !message && <ScanButton label={connecting ? '连接中…' : '连接'} onPress={() => { void confirmScan(); }} disabled={connecting} primary />}
        </View>
      </View></View>}
      </SafeAreaView>
    </View>
  </Modal>;
}
function ScanButton({ label, onPress, primary = false, disabled = false }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: primary ? theme.accent : theme.backgroundElement, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}><ThemedText style={{ color: primary ? theme.onAccent : theme.text }}>{label}</ThemedText></Pressable>;
}
const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.32)", alignItems: "center", justifyContent: "center", padding: 24 },
  screen: { flex: 1, backgroundColor: '#171717' },
  content: { flex: 1, backgroundColor: 'rgba(0,0,0,0.06)' },
  header: { minHeight: 52, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center' },
  headerTitle: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  headerTitleText: { fontSize: 18, lineHeight: 26, fontWeight: '500', color: '#FFFFFF' },
  backButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  footer: { height: 148, paddingTop: 20, paddingHorizontal: '14%' },
  serverButton: { alignSelf: 'flex-start', minWidth: 80, gap: 12, alignItems: 'center', justifyContent: 'center' },
  serverIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.24)', alignItems: 'center', justifyContent: 'center' },
  serverLabel: { fontSize: 12, lineHeight: 18, fontWeight: '400', color: '#FFFFFF' },
  title: { fontSize: 22, lineHeight: 30, fontWeight: '500' },
  preview: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cameraText: { color: '#FFFFFF', fontSize: 14, textAlign: 'center' },
  frame: { width: '72%', maxWidth: 320, aspectRatio: 1 },
  corner: { position: 'absolute', width: 20, height: 20, borderColor: '#FFFFFF' },
  topLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  topRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
  permission: { padding: 24, gap: 20, alignItems: 'center' }, card: { width: '100%', maxWidth: 360, maxHeight: '80%', padding: 24, borderRadius: 24 },
  details: { marginTop: 12, lineHeight: 24 }, actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, marginTop: 20 },
  button: { minHeight: 48, paddingHorizontal: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
