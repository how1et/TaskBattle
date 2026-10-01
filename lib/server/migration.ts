import { env } from 'cloudflare:workers';
import { fail, sql } from './context';
import { bucket } from './storage';

export const MIGRATION_SCHEMA_VERSION = 6;
export const MIGRATION_TABLES = {
  rooms: ['id'],
  tasks: ['id'],
  attempts: ['id'],
  answers: ['id'],
  attempt_intervals: ['id'],
  attempt_operations: ['attempt_id', 'request_id'],
  sheet_exports: ['attempt_id', 'format'],
  blobs: ['key'],
  expired_attempts: ['id'],
  rate_limits: ['key'],
  cancelled_answers: ['attempt_id', 'request_id'],
} as const;

type Gate = { frozen: number; frozen_at: number | null; updated_at: number };
type Row = Record<string, string | number | null>;
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const requiredObjects =
  'SELECT file_key AS key FROM tasks UNION SELECT solution_key AS key FROM answers WHERE solution_key IS NOT NULL';
const drainEnabled = () => (env as { MIGRATION_DRAIN?: string }).MIGRATION_DRAIN === '1';

async function authorize(req: Request) {
  const configured = (env as { MIGRATION_SECRET?: string }).MIGRATION_SECRET;
  if (!configured || !/^[a-fA-F0-9]{64}$/.test(configured)) fail(404, 'Страница не найдена.');
  const supplied = req.headers.get('x-migration-key') || '';
  if (!/^[a-fA-F0-9]{64}$/.test(supplied)) fail(403, 'Нет доступа.', 'migration-access');
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(supplied), digest(configured!)]);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= actual[i] ^ expected[i];
  if (difference !== 0) fail(403, 'Нет доступа.', 'migration-access');
}

async function gate() {
  const current = await sql(
    'SELECT frozen,frozen_at,updated_at FROM migration_gate WHERE singleton=1',
  ).first<Gate>();
  if (!current) fail(503, 'Миграция базы данных не подготовлена.', 'migration-schema');
  return current!;
}

export async function assertNotFrozen() {
  if ((await gate()).frozen)
    fail(503, 'Идёт перенос TaskBattle. Попробуйте немного позже.', 'maintenance');
}

async function frozenSnapshot(req: Request) {
  const current = await gate();
  if (!current.frozen || !current.frozen_at)
    fail(409, 'Сначала включите окно переноса.', 'migration-not-frozen');
  if (req.headers.get('x-migration-snapshot') !== String(current.frozen_at))
    fail(409, 'Снимок изменился. Начните перенос заново.', 'migration-snapshot-changed');
  return current;
}

async function snapshotStatus() {
  const before = await gate();
  const counts: Record<string, number> = {};
  for (const table of Object.keys(MIGRATION_TABLES)) {
    const row = await sql(`SELECT COUNT(*) AS count FROM "${table}"`).first<{ count: number }>();
    counts[table] = row!.count;
  }
  const objects = await sql(
    `SELECT COUNT(*) AS required, SUM(CASE WHEN b.key IS NULL THEN 1 ELSE 0 END) AS missing_registration, SUM(CASE WHEN b.key IS NOT NULL AND b.state!='live' THEN 1 ELSE 0 END) AS pending_deletion FROM (${requiredObjects}) r LEFT JOIN blobs b ON b.key=r.key`,
  ).first<{
    required: number;
    missing_registration: number | null;
    pending_deletion: number | null;
  }>();
  // Overdue attempts count until the normal timeout finalizer closes them.
  const active = await sql(
    'SELECT COUNT(*) AS count FROM attempts WHERE finished_at IS NULL',
  ).first<{ count: number }>();
  const after = await gate();
  if (before.frozen !== after.frozen || before.updated_at !== after.updated_at)
    fail(409, 'Состояние переноса изменилось. Повторите запрос.', 'migration-snapshot-changed');
  return {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    frozen: after.frozen === 1,
    frozenAt: after.frozen_at,
    drainEnabled: drainEnabled(),
    activeAttempts: active!.count,
    counts,
    requiredObjects: objects!.required,
    missingObjectRegistrations: objects!.missing_registration || 0,
    pendingObjectDeletions: objects!.pending_deletion || 0,
    snapshotReady:
      after.frozen === 1 &&
      active!.count === 0 &&
      !objects!.missing_registration &&
      !objects!.pending_deletion,
  };
}

function decodeCursor(value: string | null, count: number) {
  if (!value) return null;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    fail(400, 'Неверный курсор.', 'migration-cursor');
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== count ||
      parsed.some((v) => typeof v !== 'string' || v.length > 512)
    )
      throw new Error('Invalid cursor');
    return parsed as string[];
  } catch {
    fail(400, 'Неверный курсор.', 'migration-cursor');
  }
}

function encodeCursor(row: Row, columns: readonly string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(columns.map((column) => row[column])));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Called before normal app rate limits; migration must work while writes are frozen. */
export async function handleMigration(req: Request, parts: string[]) {
  await authorize(req);
  const url = new URL(req.url);
  if (parts.length === 1 && parts[0] === 'status' && req.method === 'GET')
    return Response.json(await snapshotStatus(), { headers });
  if (parts.length === 1 && ['freeze', 'unfreeze'].includes(parts[0]) && req.method === 'POST') {
    if (req.headers.get('x-confirm-migration-window') !== 'yes')
      fail(400, 'Подтвердите изменение окна переноса.', 'migration-confirm');
    if (parts[0] === 'freeze') {
      if (!drainEnabled())
        fail(
          409,
          'Сначала запретите новые старты и дождитесь завершения попыток.',
          'migration-drain-required',
        );
      // A monotonic timestamp identifies the snapshot even for rapid freeze/unfreeze cycles.
      // The predicate and freeze share one statement: an in-flight start either
      // commits first and blocks freezing, or is rejected by the frozen write triggers.
      const now = Date.now();
      await sql(
        'UPDATE migration_gate SET frozen=1,frozen_at=MAX(?,updated_at+1),updated_at=MAX(?,updated_at+1) WHERE singleton=1 AND frozen=0 AND NOT EXISTS(SELECT 1 FROM attempts WHERE finished_at IS NULL)',
        now,
        now,
      ).run();
      if (!(await gate()).frozen)
        fail(
          409,
          'Дождитесь завершения всех попыток перед переносом.',
          'migration-active-attempts',
        );
    } else {
      if (env.MIGRATION_TARGET_ORIGIN)
        fail(409, 'Старая площадка переведена в режим перенаправления.', 'bridge-source-retired');
      await sql(
        'UPDATE migration_gate SET frozen=0,frozen_at=NULL,updated_at=MAX(?,updated_at+1) WHERE singleton=1 AND frozen=1',
        Date.now(),
      ).run();
    }
    return Response.json(await snapshotStatus(), { headers });
  }
  if (req.method !== 'GET') fail(404, 'Страница не найдена.');
  const snapshot = await frozenSnapshot(req);
  if (parts.length === 2 && parts[0] === 'tables') {
    const table = parts[1];
    if (!Object.prototype.hasOwnProperty.call(MIGRATION_TABLES, table))
      fail(404, 'Таблица не найдена.', 'migration-table');
    const columns = MIGRATION_TABLES[table as keyof typeof MIGRATION_TABLES];
    const rawLimit = url.searchParams.get('limit') || '500';
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500)
      fail(400, 'Размер страницы — от 1 до 500.', 'migration-limit');
    const limit = Number(rawLimit);
    const cursor = decodeCursor(url.searchParams.get('cursor'), columns.length);
    const ordered = columns.map((column) => `"${column}"`).join(',');
    const comparison = columns.length === 1 ? ordered : `(${ordered})`;
    const placeholders = columns.length === 1 ? '?' : `(${columns.map(() => '?').join(',')})`;
    const rows = (
      await sql(
        `SELECT * FROM "${table}"${cursor ? ` WHERE ${comparison}>${placeholders}` : ''} ORDER BY ${ordered} LIMIT ?`,
        ...(cursor || []),
        limit + 1,
      ).all<Row>()
    ).results;
    await frozenSnapshot(req);
    return Response.json(
      {
        table,
        frozenAt: snapshot.frozen_at,
        rows: rows.slice(0, limit),
        nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1], columns) : null,
      },
      { headers },
    );
  }
  if (parts.length === 1 && parts[0] === 'object') {
    const key = url.searchParams.get('key');
    if (!key || key.length > 512) fail(400, 'Неверный ключ фотографии.', 'migration-object');
    const registered = await sql(
      `SELECT b.key FROM blobs b WHERE b.key=? AND b.state='live' AND EXISTS(SELECT 1 FROM (${requiredObjects}) r WHERE r.key=b.key)`,
      key,
    ).first();
    if (!registered) fail(404, 'Фотография отсутствует в снимке.', 'migration-object');
    const object = await bucket().get(key!);
    if (!object) fail(409, 'Обязательная фотография недоступна.', 'migration-object-missing');
    await frozenSnapshot(req);
    return new Response(object!.body, {
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'X-Migration-Snapshot': String(snapshot.frozen_at),
      },
    });
  }
  fail(404, 'Страница не найдена.');
}
