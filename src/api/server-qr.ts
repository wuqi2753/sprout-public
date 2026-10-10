// REQ-074: docs/stories/v0.2.0/REQ-074-connect-from-qr.md
import { normalizeServerApiUrl } from './server-connection';

export type ServerQr =
  | { type: 'pairing'; serverUrl: string; apiKey: string }
  | { type: 'cli'; serverUrl: string; expiresAt: number; userCode: string };

export function parseServerQr(encoded: string, now = Date.now()): ServerQr {
  if (encoded.length > 4096) throw new Error('二维码内容过长。');
  let fields: Record<string, unknown>;
  try { fields = JSON.parse(encoded); } catch { throw new Error('这不是 Sprout 支持的二维码。'); }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('二维码格式无效。');
  if (fields.version !== 1 || !['pairing', 'cli'].includes(String(fields.type))) throw new Error('不支持此二维码类型或版本。');
  const allowed = fields.type === 'pairing' ? ['version', 'type', 'server_url', 'api_key'] : ['version', 'type', 'server_url', 'expires_at', 'user_code'];
  if (Object.keys(fields).some((key) => !allowed.includes(key))) throw new Error('二维码包含不支持的字段。');
  if (typeof fields.server_url !== 'string') throw new Error('二维码缺少 Server 地址。');
  let address: URL;
  try { address = new URL(fields.server_url); } catch { throw new Error('Server 地址无效。'); }
  if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) throw new Error('Server 地址必须是无凭据的 HTTPS 地址。');
  const serverUrl = normalizeServerApiUrl(fields.server_url);
  if (fields.type === 'pairing') {
    if (address.port || address.pathname !== '/' || !/^https:\/\/[^/?#]+\/?$/i.test(fields.server_url.trim())) throw new Error('连接地址只填写 HTTPS 域名，不加端口或 /api/v1。');
    if (typeof fields.api_key !== 'string' || !/^[!-~]{1,512}$/.test(fields.api_key)) throw new Error('二维码中的 API Key 无效。');
    return { type: 'pairing', serverUrl, apiKey: fields.api_key };
  }
  const expiresAt = typeof fields.expires_at === 'string' ? Date.parse(fields.expires_at) : NaN;
  if (!Number.isFinite(expiresAt)) throw new Error('二维码缺少有效期。');
  if (expiresAt <= now) throw new Error('二维码已过期，请重新生成。');
  const code = fields.user_code;
  if (typeof code !== 'string' || !code.trim() || code.length > 512 || /[\s\x00-\x1f]/.test(code)) throw new Error('二维码中的配对凭据或核对码无效。');
  return { type: 'cli', serverUrl, expiresAt, userCode: code };
}

export function validateQrConnection(qr: ServerQr, savedServerUrl: string | undefined, connected: boolean, allowPairing: boolean) {
  if (qr.type === 'pairing') {
    if (savedServerUrl && !allowPairing) throw new Error('请到服务器设置更换连接。');
    return;
  }
  if (!savedServerUrl) throw new Error('请先连接你的 Server，再扫描 CLI 登录二维码。');
  const saved = new URL(savedServerUrl);
  const scanned = new URL(qr.serverUrl);
  if (saved.origin !== scanned.origin || saved.pathname.replace(/\/$/, '') !== scanned.pathname.replace(/\/$/, '')) throw new Error('此 CLI 申请来自其他 Server，无法授权。');
  if (!connected) throw new Error('Server 尚未连接，请先重试连接。');
}
