export type ServerConnectionConfig = {
  serverApiUrl: string;
  apiKey: string;
};

export type ServerConnectionErrorKind = 'authentication' | 'network' | 'response' | 'url';

export class ServerConnectionError extends Error {
  constructor(
    public readonly kind: ServerConnectionErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ServerConnectionError';
  }
}

export function normalizeServerApiUrl(value: string) {
  const trimmedValue = value.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedValue);
  } catch (error) {
    throw new ServerConnectionError('url', 'Server API 地址必须是完整的 HTTP 或 HTTPS 地址。', {
      cause: error,
    });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ServerConnectionError('url', 'Server API 地址只支持 HTTP 或 HTTPS。');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new ServerConnectionError('url', 'Server API 地址不能包含凭据、查询参数或片段。');
  }
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '');
  return parsedUrl.toString().replace(/\/$/, '');
}

export async function probeServerConnection(config: ServerConnectionConfig) {
  const serverApiUrl = normalizeServerApiUrl(config.serverApiUrl);
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new ServerConnectionError('authentication', 'API Key 不能为空。');

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(`${serverApiUrl}/api/v1/health`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: abortController.signal,
    });
  } catch (error) {
    throw new ServerConnectionError('network', '无法连接到 Server，请检查地址、网络和服务状态。', {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new ServerConnectionError('authentication', 'API Key 无效。');
  }
  if (!response.ok) {
    throw new ServerConnectionError('response', `Server 返回了 HTTP ${response.status}。`);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error) {
    throw new ServerConnectionError('response', 'Server 返回的不是有效 JSON。', { cause: error });
  }
  if (
    typeof responseBody !== 'object' ||
    responseBody === null ||
    !('status' in responseBody) ||
    responseBody.status !== 'ok'
  ) {
    throw new ServerConnectionError('response', 'Server 返回了无法识别的连接状态。');
  }
}
