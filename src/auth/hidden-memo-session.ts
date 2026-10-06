// REQ-044: One volatile access session shared by the list and editor.
import { authenticateHiddenMemos, type BiometricAuthenticationResult } from './biometric-authentication';

export function createHiddenMemoSession(authenticate: () => Promise<BiometricAuthenticationResult>) {
  let snapshot = { unlocked: false, authenticating: false };
  let attemptVersion = 0;
  let appState = 'active';
  const subscribers = new Set<() => void>();

  function publish(next: typeof snapshot) {
    snapshot = next;
    subscribers.forEach((subscriber) => subscriber());
  }

  function lock() {
    attemptVersion += 1;
    if (snapshot.unlocked) publish({ ...snapshot, unlocked: false });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(subscriber: () => void) {
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    lock,
    setAppState(next: string) {
      appState = next;
      if (next === 'background' || (next !== 'active' && snapshot.unlocked)) lock();
    },
    async unlock(): Promise<BiometricAuthenticationResult> {
      if (snapshot.authenticating || appState === 'background') return { success: false, cancelled: true };
      if (snapshot.unlocked) return { success: true };
      const version = ++attemptVersion;
      publish({ unlocked: false, authenticating: true });
      try {
        const result = await authenticate();
        if (version !== attemptVersion) return { success: false, cancelled: true };
        if (result.success) publish({ unlocked: true, authenticating: true });
        return result;
      } finally {
        publish({ ...snapshot, authenticating: false });
      }
    },
  };
}

export const hiddenMemoSession = createHiddenMemoSession(authenticateHiddenMemos);
