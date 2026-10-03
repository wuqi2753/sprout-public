import * as SecureStore from 'expo-secure-store';

import type { ServerConnectionConfig } from '@/api/server-connection';

const SERVER_API_URL_KEY = 'sprout.server-api-url';
const SERVER_API_KEY_KEY = 'sprout.server-api-key';

export async function getServerConnectionConfig(): Promise<ServerConnectionConfig | undefined> {
  const [serverApiUrl, apiKey] = await Promise.all([
    SecureStore.getItemAsync(SERVER_API_URL_KEY),
    SecureStore.getItemAsync(SERVER_API_KEY_KEY),
  ]);
  if (serverApiUrl === null && apiKey === null) return undefined;
  if (serverApiUrl === null || apiKey === null) {
    throw new Error('Stored Server connection config is incomplete');
  }
  return { serverApiUrl, apiKey };
}

export async function saveServerConnectionConfig(config: ServerConnectionConfig) {
  await SecureStore.setItemAsync(SERVER_API_URL_KEY, config.serverApiUrl);
  try {
    await SecureStore.setItemAsync(SERVER_API_KEY_KEY, config.apiKey);
  } catch (error) {
    await SecureStore.deleteItemAsync(SERVER_API_URL_KEY);
    throw new Error('Failed to save Server connection securely', { cause: error });
  }
}
