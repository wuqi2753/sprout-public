import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { probeServerConnection } from '@/api/server-connection';
import type { ServerConnectionStatus } from '@/components/explore-filter-panel';
import { getServerConnectionConfig } from '@/storage/server-connection';

export function useServerConnection() {
  const [serverUrl, setServerUrl] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [focused, setFocused] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ServerConnectionStatus>('unconfigured');

  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  useEffect(() => {
      if (!focused) return;
      let active = true;

      async function refreshConnectionStatus() {
        try {
          const config = await getServerConnectionConfig();
          if (!active) return;
          setServerUrl(config?.serverApiUrl);
          if (!config) {
            setConnectionStatus('unconfigured');
            return;
          }
          setConnectionStatus('connecting');
          await probeServerConnection(config);
          if (active) setConnectionStatus('connected');
        } catch {
          if (active) setConnectionStatus('failed');
        }
      }

      refreshConnectionStatus();
      return () => {
        active = false;
      };
    }, [focused, refreshVersion]);

  return { connectionStatus, serverUrl, retryConnection: () => setRefreshVersion((version) => version + 1) };
}

export function useServerConnectionStatus() { return useServerConnection().connectionStatus; }
