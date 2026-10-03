import type { ServerConnectionConfig } from '@/api/server-connection';

let browserConfig: ServerConnectionConfig | undefined;

export async function getServerConnectionConfig() {
  return browserConfig;
}

export async function saveServerConnectionConfig(config: ServerConnectionConfig) {
  browserConfig = config;
}
