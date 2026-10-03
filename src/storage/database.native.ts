import * as SQLite from 'expo-sqlite';

import { createUuid } from '@/sync/uuid';

const DATABASE_NAME = 'sprout.db';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

// REQ-037: Build an empty schema; existing rows only participate in required migrations.
async function initializeDatabase(database: SQLite.SQLiteDatabase) {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_initialization (
      name TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS memo_images (
      id TEXT PRIMARY KEY NOT NULL,
      memo_id TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL CHECK (position >= 0),
      FOREIGN KEY (memo_id) REFERENCES memos(id) ON DELETE CASCADE,
      UNIQUE (memo_id, position)
    );
    CREATE INDEX IF NOT EXISTS memo_images_memo_id_index ON memo_images(memo_id);
    CREATE TABLE IF NOT EXISTS memo_outbox (
      operation_id TEXT PRIMARY KEY NOT NULL,
      memo_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
      payload TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'retryable_failed', 'permanent_failed', 'acked')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      result_version INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memo_outbox_pending_index ON memo_outbox(state, created_at);
    CREATE INDEX IF NOT EXISTS memo_outbox_memo_id_index ON memo_outbox(memo_id, created_at);
    DELETE FROM memo_images
    WHERE NOT EXISTS (SELECT 1 FROM memos WHERE memos.id = memo_images.memo_id);
  `);
  const memoColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(memos)');
  if (!memoColumns.some((column) => column.name === 'server_version')) {
    await database.execAsync('ALTER TABLE memos ADD COLUMN server_version INTEGER');
  }
  const legacyMemos = await database.getAllAsync<{
    id: string;
    content: string;
    created_at: string;
  }>(
    `SELECT id, content, created_at FROM memos
     WHERE NOT EXISTS (SELECT 1 FROM memo_outbox WHERE memo_outbox.memo_id = memos.id)`,
  );
  if (legacyMemos.length > 0) {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      for (const memo of legacyMemos) {
        await transaction.runAsync(
          `INSERT INTO memo_outbox
            (operation_id, memo_id, operation, payload, state, created_at)
           VALUES (?, ?, 'create', ?, 'pending', ?)`,
          createUuid(),
          memo.id,
          JSON.stringify({ content: memo.content, created_at: memo.created_at }),
          memo.created_at,
        );
      }
    });
  }
  const migrationVersion = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((migrationVersion?.user_version ?? 0) < 1) {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const imageRows = await transaction.getAllAsync<{ memo_id: string; id: string; object_key: string }>(
        'SELECT memo_id, id, object_key FROM memo_images ORDER BY memo_id, position',
      );
      const imagesByMemo = new Map<string, { id: string; object_key: string }[]>();
      for (const image of imageRows) {
        const objects = imagesByMemo.get(image.memo_id) ?? [];
        objects.push({ id: image.id, object_key: image.object_key });
        imagesByMemo.set(image.memo_id, objects);
      }
      for (const [memoId, imageObjects] of imagesByMemo) {
        const images = imageObjects.map((image) => image.id);
        const operations = await transaction.getAllAsync<{
          operation_id: string; operation: string; payload: string; state: string;
          attempt_count: number; last_error: string | null;
        }>('SELECT operation_id, operation, payload, state, attempt_count, last_error FROM memo_outbox WHERE memo_id = ? ORDER BY rowid', memoId);
        const create = operations.find((operation) => operation.operation === 'create');
        if (!create) throw new Error(`Missing create operation for image memo ${memoId}`);
        if (create.state === 'acked' || (create.attempt_count > 0 && create.last_error !== 'invalid_content')) {
          const latest = operations.at(-1);
          if (latest?.operation === 'delete') continue;
          const memo = await transaction.getFirstAsync<{ content: string; updated_at: string }>(
            'SELECT content, updated_at FROM memos WHERE id = ?', memoId,
          );
          if (!memo) continue;
          await transaction.runAsync(
            `INSERT INTO memo_outbox (operation_id, memo_id, operation, payload, state, created_at)
             VALUES (?, ?, 'update', ?, 'pending', ?)`,
            createUuid(), memoId, JSON.stringify({ content: memo.content, images, image_objects: imageObjects }), memo.updated_at,
          );
        } else {
          const payload = JSON.parse(create.payload) as { content: string; created_at: string };
          await transaction.runAsync(
            `UPDATE memo_outbox SET payload = ?, state = 'pending', last_error = NULL, next_attempt_at = NULL
             WHERE operation_id = ?`,
            JSON.stringify({ ...payload, images, image_objects: imageObjects }), create.operation_id,
          );
        }
      }
      await transaction.execAsync('PRAGMA user_version = 1');
    });
  }
}

async function openDatabase() {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  try {
    await initializeDatabase(database);
    return database;
  } catch (error) {
    try {
      await database.closeAsync();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Failed to initialize and close App SQLite database');
    }
    throw new Error('Failed to initialize App SQLite database', { cause: error });
  }
}

export function getDatabase() {
  databasePromise ??= openDatabase().catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}
