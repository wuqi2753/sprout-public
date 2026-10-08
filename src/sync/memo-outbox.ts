export async function syncMemoOutbox() {}
const browserSyncProgress = { syncing: false, remainingOperations: 0 };
export function getMemoSyncProgress() { return browserSyncProgress; }
export function subscribeMemoSyncProgress(_listener: () => void) { return () => {}; }
