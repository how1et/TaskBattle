import { db, sql } from './context';
import { bucket } from './storage';
export async function cleanup() {
  const now = Date.now();
  await db().batch([
    sql(
      `INSERT OR IGNORE INTO expired_attempts(id,secret_hash,teacher_hash,reason) SELECT a.id,a.secret_hash,r.teacher_hash,CASE WHEN a.finished_at IS NULL THEN 'room' ELSE 'result' END FROM attempts a JOIN rooms r ON r.id=a.room_id WHERE (a.finished_at IS NOT NULL AND COALESCE(a.result_expires_at,a.finished_at+259200000)<=?) OR (a.finished_at IS NULL AND r.expires_at<=?)`,
      now,
      now,
    ),
    sql(
      `DELETE FROM attempts WHERE (finished_at IS NOT NULL AND COALESCE(result_expires_at,finished_at+259200000)<=?) OR (finished_at IS NULL AND room_id IN(SELECT id FROM rooms WHERE expires_at<=?))`,
      now,
      now,
    ),
    sql(
      `UPDATE blobs SET state='deleting' WHERE key IN(SELECT b.key FROM blobs b WHERE b.state='live' AND b.expires_at<=? AND NOT EXISTS(SELECT 1 FROM tasks t JOIN rooms r ON r.id=t.room_id WHERE t.file_key=b.key AND (r.expires_at>? OR EXISTS(SELECT 1 FROM attempts a WHERE a.room_id=r.id AND a.finished_at IS NOT NULL AND COALESCE(a.result_expires_at,a.finished_at+259200000)>?))) AND NOT EXISTS(SELECT 1 FROM answers x JOIN attempts a ON a.id=x.attempt_id JOIN rooms r ON r.id=a.room_id WHERE x.solution_key=b.key AND ((a.finished_at IS NULL AND r.expires_at>?) OR COALESCE(a.result_expires_at,a.finished_at+259200000)>?)) LIMIT 500)`,
      now,
      now,
      now,
      now,
      now,
    ),
  ]);
  const doomed = (
    await sql("SELECT key FROM blobs WHERE state='deleting' LIMIT 500").all<{ key: string }>()
  ).results;
  for (let i = 0; i < doomed.length; i += 100)
    await bucket().delete(doomed.slice(i, i + 100).map((x) => x.key));
  if (doomed.length)
    await db().batch(
      doomed.map((x) => sql("DELETE FROM blobs WHERE key=? AND state='deleting'", x.key)),
    );
  await sql(
    'DELETE FROM rooms WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM attempts WHERE room_id=rooms.id) AND NOT EXISTS(SELECT 1 FROM tasks JOIN blobs ON blobs.key=tasks.file_key WHERE tasks.room_id=rooms.id)',
    now,
  ).run();
  await sql('DELETE FROM rate_limits WHERE expires_at<=?', now).run();
  return { ok: true, deletedFiles: doomed.length };
}
