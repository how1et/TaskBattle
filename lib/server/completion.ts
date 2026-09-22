import { LIMITS } from '../limits';
import { db, sql, type Attempt } from './context';

// A terminal transition and retention changes share a D1 transaction. Answers
// use the same unfinished/deadline predicate, so only one transition can win.
function retention(id: string) {
  return [
    sql(
      `UPDATE blobs SET expires_at=MAX(expires_at,(SELECT result_expires_at FROM attempts WHERE id=?)) WHERE key IN(SELECT file_key FROM tasks WHERE room_id=(SELECT room_id FROM attempts WHERE id=?)) AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NOT NULL)`,
      id,
      id,
      id,
    ),
    sql(
      `UPDATE blobs SET expires_at=(SELECT result_expires_at FROM attempts WHERE id=?) WHERE key IN(SELECT solution_key FROM answers WHERE attempt_id=?) AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NOT NULL)`,
      id,
      id,
      id,
    ),
  ];
}
export async function expireAttempt(id: string, now = Date.now()) {
  await sql(
    `UPDATE attempts SET finished_at=deadline_at,result_expires_at=deadline_at+?,finish_reason='timeout',unfinished_ms=0,timing_incomplete=CASE WHEN ready_id IS NOT NULL OR (timing_version=1 AND task_started_at>0) THEN 1 ELSE 0 END WHERE id=? AND finished_at IS NULL AND deadline_at<=?`,
    LIMITS.resultTtlMs,
    id,
    now,
  ).run();
}
export async function finalizeDue(roomId?: string, batchSize = 500) {
  const now = Date.now();
  await sql(
    `UPDATE attempts SET deadline_at=started_at+? WHERE id IN(SELECT id FROM attempts WHERE finished_at IS NULL AND deadline_at IS NULL ${roomId ? 'AND room_id=?' : ''} LIMIT ?)`,
    LIMITS.attemptTtlMs,
    ...(roomId ? [roomId] : []),
    batchSize,
  ).run();
  // Retention is also enforced by cleanup's reference predicates; no per-row
  // storage requests are needed for a bounded bulk terminal transition.
  const rows = (
    await sql(
      `UPDATE attempts SET finished_at=deadline_at,result_expires_at=deadline_at+?,finish_reason='timeout',unfinished_ms=0,timing_incomplete=CASE WHEN ready_id IS NOT NULL OR (timing_version=1 AND task_started_at>0) THEN 1 ELSE 0 END WHERE id IN(SELECT id FROM attempts WHERE finished_at IS NULL AND deadline_at<=? ${roomId ? 'AND room_id=?' : ''} ORDER BY deadline_at LIMIT ?) AND finished_at IS NULL RETURNING id`,
      LIMITS.resultTtlMs,
      now,
      ...(roomId ? [roomId] : []),
      batchSize,
    ).all<{ id: string }>()
  ).results;
  return rows.length;
}
export async function finishAttempt(
  a: Attempt,
  requestId: string,
  position: number,
  durationMs: number,
) {
  await expireAttempt(a.id);
  const now = Date.now();
  await db().batch([
    sql(
      `UPDATE attempts SET finished_at=?,result_expires_at=?,finish_reason='manual',finish_request_id=?,unfinished_ms=CASE WHEN position=? THEN ? ELSE 0 END,timing_incomplete=CASE WHEN position<>? AND (ready_id IS NOT NULL OR (timing_version=1 AND task_started_at>0)) THEN 1 ELSE 0 END WHERE id=? AND finished_at IS NULL AND deadline_at>?`,
      now,
      now + LIMITS.resultTtlMs,
      requestId,
      position,
      durationMs,
      position,
      a.id,
      now,
    ),
    ...retention(a.id),
  ]);
}
