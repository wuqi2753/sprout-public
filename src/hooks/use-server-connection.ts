import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { probeServerConnection } from '@/api/server-connection';
import type { ServerConnectionStatus } from '@/components/explore-filter-panel';
import { getServerConnectionConfig } from '@/storage/server-connection';

export function useServerConnectionStatus() {
  const [connectionStatus, setConnectionStatus] = useState<ServerConnectionStatus>('unconfigured');

  useFocusEffect(
    useCallback(() => {
      let active = true;

      async function refreshConnectionStatus() {
        try {
          const config = await getServerConnectionConfig();
          if (!active) return;
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
    }, []),
  );

  return connectionStatus;
}
