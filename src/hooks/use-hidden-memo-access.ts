// REQ-044: The root owns lifecycle locking; screens subscribe to the same session.
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { hiddenMemoSession } from '@/auth/hidden-memo-session';

export function useHiddenMemoAccess() {
  return useSyncExternalStore(hiddenMemoSession.subscribe, hiddenMemoSession.getSnapshot, hiddenMemoSession.getSnapshot);
}

export function useHiddenMemoLifecycle() {
  useEffect(() => {
    hiddenMemoSession.setAppState(AppState.currentState);
    const subscription = AppState.addEventListener('change', hiddenMemoSession.setAppState);
    return () => {
      subscription.remove();
      hiddenMemoSession.lock();
    };
  }, []);
}
