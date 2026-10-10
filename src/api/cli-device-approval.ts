// REQ-096: docs/stories/v0.2.0/REQ-096-app-cli-device-approval.md
import { normalizeServerApiUrl, type ServerConnectionConfig } from './server-connection';

export type CliDeviceRequest = {
  userCode: string; clientId: string; scope: string[]; expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
};
export const cliPermissionLabels: Record<string, string> = {
  'notes:read': '读取笔记、图片和文件附件',
  'subscriptions:manage': '管理 CLI 工作空间订阅与同步进度',
};
export class CliApprovalError extends Error {
  constructor(message: string, public readonly uncertain = false) { super(message); }
}
export function validateCliRequest(fields: unknown, userCode: string): CliDeviceRequest {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new CliApprovalError('Server 返回的授权申请格式无效。');
  const request = fields as Record<string, unknown>;
  if (request.user_code !== userCode || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) || request.client_id !== 'sprout-cli' ||
      typeof request.scope !== 'string' || typeof request.expires_at !== 'string' ||
      !['pending', 'approved', 'denied', 'expired', 'consumed'].includes(String(request.status))) {
    throw new CliApprovalError('Server 返回的申请身份、核对码或状态无效。');
  }
  const scope = request.scope.split(' ');
  if (!scope.length || new Set(scope).size !== scope.length || scope.some((permission) => !Object.hasOwn(cliPermissionLabels, permission))) {
    throw new CliApprovalError('申请包含无法识别的权限，不能批准。');
  }
  const expiresAt = Date.parse(request.expires_at);
  if (!Number.isFinite(expiresAt)) throw new CliApprovalError('Server 返回的申请期限无效。');
  return { userCode, clientId: request.client_id, scope, expiresAt, status: request.status as CliDeviceRequest['status'] };
}
export function cliRequestStatusMessage(request: CliDeviceRequest): string | undefined {
  if (Date.now() >= request.expiresAt || request.status === 'expired') return '申请已过期，请在 CLI 重新登录。';
  return { pending: undefined, approved: '申请已批准，CLI 将自行领取凭据。', denied: '申请已拒绝。', consumed: 'CLI 已领取此申请的凭据。' }[request.status];
}
export async function requestCliApproval(config: ServerConnectionConfig, userCode: string, signal: AbortSignal, decision?: 'approve' | 'deny'): Promise<CliDeviceRequest> {
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) throw new CliApprovalError('核对码格式无效。');
  const origin = normalizeServerApiUrl(config.serverApiUrl);
  if (!origin.startsWith('https://') || !/^[!-~]{1,512}$/.test(config.apiKey)) throw new CliApprovalError('连接凭据无效，请重新连接 Server。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 8000);
  try {
    const response = await fetch(`${origin}/oauth/device_requests/${userCode}${decision ? '/decision' : ''}`, {
      method: decision ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}`, ...(decision ? { 'Content-Type': 'application/json' } : {}) },
      ...(decision ? { body: JSON.stringify({ decision }) } : {}),
    });
    if (!response.ok) {
      const messages: Record<number, string> = { 401: '连接凭据无效，请重新连接 Server。', 404: '授权申请不存在，请在 CLI 重新登录。', 409: '申请状态已变化，请重新查询。', 410: '申请已过期，请在 CLI 重新登录。' };
      throw new CliApprovalError(messages[response.status] ?? `授权请求失败（HTTP ${response.status}），请重试。`, !!decision && (response.status >= 500 || response.status === 409 || response.status === 410));
    }
    let fields: unknown;
    try { fields = await response.json(); } catch { throw new CliApprovalError('Server 返回的授权响应不是有效 JSON。', !!decision); }
    let request: CliDeviceRequest;
    try { request = validateCliRequest(fields, userCode); }
    catch { throw new CliApprovalError('Server 返回的申请身份、权限或状态无效，不能审批。', !!decision); }
    if (decision && request.status !== (decision === 'approve' ? 'approved' : 'denied')) throw new CliApprovalError('审批结果需要重新查询确认。', true);
    return request;
  } catch (error) {
    if (error instanceof CliApprovalError) throw error;
    throw new CliApprovalError(decision ? '审批结果未确认，请重新查询申请状态。' : '无法查询申请，请检查网络后重试。', !!decision);
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
