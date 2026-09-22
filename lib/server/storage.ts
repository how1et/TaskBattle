import { env } from 'cloudflare:workers';
import { fail, sql } from './context';
export const bucket = () => {
  if (!env.BUCKET) fail(503, 'Фотографии временно недоступны. Попробуйте позже.');
  return env.BUCKET!;
};
export async function discardUnusedPhoto(key: string | null) {
  if (!key) return;
  try {
    // A very late PUT can outlive an orphan lease already deleted by cleanup.
    // Re-register only unreferenced keys so its eventual deletion stays durable.
    await sql(
      "INSERT INTO blobs(key,expires_at,state) SELECT ?,0,'live' WHERE NOT EXISTS(SELECT 1 FROM answers WHERE solution_key=?) ON CONFLICT(key) DO NOTHING",
      key,
      key,
    ).run();
    const claimed = await sql(
      "UPDATE blobs SET state='deleting' WHERE key=? AND state IN('live','deleting') AND NOT EXISTS(SELECT 1 FROM answers WHERE solution_key=?) RETURNING key",
      key,
      key,
    ).first();
    if (claimed) {
      await bucket().delete(key);
      await sql("DELETE FROM blobs WHERE key=? AND state='deleting'", key).run();
    }
  } catch {
    /* Registered orphan remains eligible for scheduled cleanup. */
  }
}
