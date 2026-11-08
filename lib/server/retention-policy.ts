import { env } from 'cloudflare:workers';
import { LIMITS } from '../limits';

export const LEGACY_RESULT_TTL = 72 * 3600000;
const POLICY_KEY = 'results-28-days';
const cutoffSql = `(SELECT applied_at FROM retention_policy WHERE key='${POLICY_KEY}')`;
const sql = (query: string, ...args: (string | number)[]) => env.DB!.prepare(query).bind(...args);
const field = (alias: string, name: string) => (alias ? `${alias}.${name}` : name);

// Identifiers are internal literals, never request parameters. All references,
// including rows outside a cleanup batch, use the same persisted transition.
export function effectiveResultTtlSql(alias = '') {
  const f = (name: string) => field(alias, name);
  const oldExpiry = `CASE WHEN ${f('finished_at')} IS NOT NULL THEN COALESCE(${f('result_expires_at')},${f('finished_at')}+${LEGACY_RESULT_TTL}) ELSE COALESCE(${f('deadline_at')},${f('started_at')}+${LIMITS.attemptTtlMs})+${LEGACY_RESULT_TTL} END`;
  return `COALESCE(${f('result_ttl_ms')},CASE WHEN (${oldExpiry})>${cutoffSql} THEN ${LIMITS.resultTtlMs} ELSE ${LEGACY_RESULT_TTL} END)`;
}

export function effectiveResultExpirySql(alias = '') {
  const f = (name: string) => field(alias, name);
  const oldExpiry = `COALESCE(${f('result_expires_at')},${f('finished_at')}+${LEGACY_RESULT_TTL})`;
  return `(CASE WHEN ${f('result_ttl_ms')}=${LIMITS.resultTtlMs} THEN ${f('finished_at')}+${LIMITS.resultTtlMs} WHEN ${f('result_ttl_ms')} IS NULL THEN CASE WHEN ${oldExpiry}>${cutoffSql} THEN ${f('finished_at')}+${LIMITS.resultTtlMs} ELSE ${oldExpiry} END ELSE COALESCE(${f('result_expires_at')},${f('finished_at')}+${f('result_ttl_ms')}) END)`;
}

export function effectiveAttemptExpirySql(alias = '') {
  const f = (name: string) => field(alias, name);
  return `(CASE WHEN ${f('finished_at')} IS NOT NULL THEN ${effectiveResultExpirySql(alias)} ELSE COALESCE(${f('deadline_at')},${f('started_at')}+${LIMITS.attemptTtlMs})+${effectiveResultTtlSql(alias)} END)`;
}

export function effectiveRoomExpirySql(alias = '') {
  const f = (name: string) => field(alias, name);
  return `(CASE WHEN ${f('expires_at')}>${cutoffSql} THEN ${f('created_at')}+${LIMITS.roomTtlMs} ELSE ${f('expires_at')} END)`;
}

export async function ensureRetentionPolicy(now = Date.now()) {
  await sql(
    'INSERT INTO retention_policy(key,applied_at) VALUES(?,?) ON CONFLICT(key) DO NOTHING',
    POLICY_KEY,
    now,
  ).run();
  const row = await sql('SELECT applied_at FROM retention_policy WHERE key=?', POLICY_KEY).first<{
    applied_at: number;
  }>();
  return row!.applied_at;
}

export async function normalizeRoomRetention(id: string) {
  await ensureRetentionPolicy();
  await sql(
    `UPDATE rooms SET expires_at=${effectiveRoomExpirySql()} WHERE id=? AND expires_at<>${effectiveRoomExpirySql()}`,
    id,
  ).run();
}

const pendingAttempt = `(result_ttl_ms IS NULL OR (result_ttl_ms=${LIMITS.resultTtlMs} AND finished_at IS NOT NULL AND result_expires_at IS NOT finished_at+${LIMITS.resultTtlMs}))`;

function attemptUpdate(where: string) {
  // SQLite evaluates all right-hand expressions from the original row. Classify
  // before changing expiry so an old expired record can never become eligible.
  return `UPDATE attempts SET result_ttl_ms=${effectiveResultTtlSql()},result_expires_at=CASE WHEN finished_at IS NOT NULL THEN ${effectiveResultExpirySql()} ELSE result_expires_at END,deadline_at=COALESCE(deadline_at,started_at+${LIMITS.attemptTtlMs}) WHERE ${pendingAttempt} AND ${where}`;
}

export async function normalizeAttemptRetention(id: string) {
  await ensureRetentionPolicy();
  await sql(attemptUpdate('id=?'), id).run();
}

export async function migrateRetentionBatch(limit = 500) {
  await ensureRetentionPolicy();
  const batchSize = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rooms = await sql(
    `UPDATE rooms SET expires_at=${effectiveRoomExpirySql()} WHERE id IN(SELECT id FROM rooms WHERE expires_at<>${effectiveRoomExpirySql()} ORDER BY id LIMIT ?) RETURNING id`,
    batchSize,
  ).all<{ id: string }>();
  const attempts = await sql(
    attemptUpdate(`id IN(SELECT id FROM attempts WHERE ${pendingAttempt} ORDER BY id LIMIT ?)`) +
      ' RETURNING id',
    batchSize,
  ).all<{ id: string }>();
  return rooms.results.length + attempts.results.length;
}
