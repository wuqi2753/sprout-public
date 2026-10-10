// REQ-087–REQ-092: stable machine failures with actionable recovery.
import { StorageBusy } from './disk.js';
import { HTTPFailure } from './http.js';
export class CommandFailure extends Error {
  constructor(readonly code: string, message: string, readonly nextAction: string, readonly retryable = false) { super(message); }
}
export function failure(error: unknown, invalidArguments = false, interrupted = false) {
  if (interrupted) return { code: 'INTERRUPTED', message: 'Command interrupted.', retryable: true, next_action: 'Retry the same command; token exchange or refresh interruption may require login.' };
  if (invalidArguments) return { code: 'INVALID_ARGUMENTS', message: error instanceof Error ? error.message : 'Invalid arguments.', retryable: false, next_action: 'Read sprout describe --json and correct the parameters.' };
  if (error instanceof CommandFailure) return { code: error.code, message: error.message, retryable: error.retryable, next_action: error.nextAction };
  if (error instanceof StorageBusy) return { code: 'WORKSPACE_BUSY', message: error.message, retryable: true, next_action: 'Wait for the other command to exit, then retry.' };
  if (error instanceof HTTPFailure) return { code: error.status === 401 ? 'AUTH_REQUIRED' : 'SERVER_ERROR', message: error.message, server_code: error.code, retryable: error.status >= 500 || error.status === 429, next_action: error.status === 401 ? 'Run login for this Server.' : error.status === 409 ? 'Inspect status and resolve the subscription conflict; do not overwrite progress.' : 'Check Server status and the saved operation; retry only with the original arguments.' };
  const code = (error as NodeJS.ErrnoException)?.code;
  return { code: code && /^[A-Z_]+$/.test(code) ? 'STORAGE_ERROR' : 'COMMAND_FAILED', message: code && /^[A-Z_]+$/.test(code) ? `Local storage failed (${code}).` : error instanceof Error ? error.message : 'Command failed.', retryable: false, next_action: 'Inspect local state and retry after correcting the failure; never discard receipt or creation intent.' };
}
