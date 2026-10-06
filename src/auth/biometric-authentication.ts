// REQ-044: Web must never bypass native biometric verification.
export type BiometricAuthenticationResult =
  | { success: true }
  | { success: false; cancelled: boolean; message?: string };

export async function authenticateHiddenMemos(): Promise<BiometricAuthenticationResult> {
  return { success: false, cancelled: false, message: '请在 Android 或 iOS App 中使用生物识别查看隐藏笔记。' };
}
