// REQ-044: docs/stories/v0.3.0/REQ-044-biometric-hidden-memos.md
import { Platform } from 'react-native';

import type { BiometricAuthenticationResult } from './biometric-authentication';

export async function authenticateHiddenMemos(): Promise<BiometricAuthenticationResult> {
  // Loading at the boundary lets older installed binaries fail with an upgrade message.
  let authentication: typeof import('expo-local-authentication');
  try {
    authentication = await import('expo-local-authentication');
  } catch (error) {
    throw new Error('当前安装包尚未支持生物识别，请升级 App 后重试。', { cause: error });
  }
  if (!await authentication.hasHardwareAsync()) {
    return { success: false, cancelled: false, message: '此设备没有可用的生物识别硬件，无法查看隐藏笔记。' };
  }
  if (!await authentication.isEnrolledAsync()) {
    return { success: false, cancelled: false, message: '请先在系统设置中录入指纹或面容，再查看隐藏笔记。' };
  }
  if (Platform.OS === 'android' && await authentication.getEnrolledLevelAsync() !== authentication.SecurityLevel.BIOMETRIC_STRONG) {
    return { success: false, cancelled: false, message: '请在系统设置中录入指纹或支持强生物识别的面容，再查看隐藏笔记。' };
  }
  const result = await authentication.authenticateAsync({
    promptMessage: '解锁隐藏笔记',
    promptSubtitle: '验证通过后才能查看',
    cancelLabel: '取消',
    disableDeviceFallback: true,
    fallbackLabel: '',
    biometricsSecurityLevel: 'strong',
  });
  if (!result || typeof result.success !== 'boolean' || (!result.success && typeof result.error !== 'string')) {
    throw new Error('系统返回了无效的生物识别验证结果，请稍后重试。');
  }
  if (result.success) return { success: true };
  if (['user_cancel', 'app_cancel', 'system_cancel'].includes(result.error)) {
    return { success: false, cancelled: true };
  }
  const messages: Partial<Record<typeof result.error, string>> = {
    not_enrolled: '请先在系统设置中录入指纹或面容。',
    not_available: '生物识别暂时不可用，请检查系统设置后重试。',
    lockout: '生物识别已被系统暂时锁定，请稍后重试。',
    timeout: '验证超时，请重新点击隐藏笔记。',
    authentication_failed: '验证未通过，请重新点击隐藏笔记。',
    passcode_not_set: '请先在系统设置中配置屏幕锁定和生物识别。',
  };
  return { success: false, cancelled: false, message: messages[result.error] ?? '未能完成生物识别验证，请稍后重试。' };
}
