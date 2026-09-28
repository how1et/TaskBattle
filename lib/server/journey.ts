import { LIMITS } from '../limits';
import { inspectImage } from '../image-file';
import { normalizeAnswer } from '../normalization';
import type { JourneyAnswer } from '../journey-types';
import { answerBody, snapshot, assertAccessTime } from './attempts';
import {
  body,
  db,
  fail,
  hash,
  random,
  roomTasks,
  sql,
  validId,
  type Attempt,
  type Room,
} from './context';
import { retention } from './completion';
import { bucket, discardUnusedPhoto } from './storage';

type Interval = {
  id: string;
  task_id: string;
  owner: string;
  started_at: number | null;
  duration_ms: number;
  closed_at: number | null;
};
type Answer = {
  task_id: string;
  answer: string;
  revision: number;
  correct: number;
  solution_key: string | null;
  solution_mime: string | null;
  solution_digest: string | null;
  started_at: number;
  answered_at: number;
};
const fresh = async (id: string) =>
  (await sql('SELECT * FROM attempts WHERE id=?', id).first<Attempt>())!;

/** One-time additive upgrade. Historical slot indices and completed reports are preserved. */
export async function openJourney(a: Attempt, r: Room) {
  if (a.timing_version < 3 && a.finished_at === null) {
    await db().batch([
      sql(
        `INSERT OR IGNORE INTO attempt_intervals(id,attempt_id,task_id,owner,started_at,duration_ms,closed_at) SELECT 'seed-'||id,attempt_id,task_id,'legacy',started_at,duration_ms,answered_at FROM answers WHERE attempt_id=?`,
        a.id,
      ),
      sql(
        `INSERT OR IGNORE INTO attempt_intervals(id,attempt_id,task_id,owner,started_at,duration_ms) SELECT 'legacy-'||id,id,json_extract(order_json,'$['||position||']'),'legacy',task_started_at,0 FROM attempts WHERE id=? AND timing_version<3 AND finished_at IS NULL AND (ready_id IS NOT NULL OR timing_version=1)`,
        a.id,
      ),
      sql(
        `UPDATE attempts SET timing_version=3,selected_task_id=json_extract(order_json,'$['||position||']'),state_version=state_version+1,ready_id=CASE WHEN ready_id IS NOT NULL OR timing_version=1 THEN 'legacy-'||id ELSE NULL END WHERE id=? AND timing_version<3 AND finished_at IS NULL`,
        a.id,
      ),
    ]);
  }
  return snapshot(await fresh(a.id), r);
}

export async function journeyControl(req: Request, a: Attempt, r: Room) {
  const d = await body(req),
    now = Date.now();
  a = await fresh(a.id);
  await assertAccessTime(a, r);
  if (a.finished_at !== null) return snapshot(a, r);
  if (a.timing_version !== 3) fail(409, 'Обновите страницу.');
  if (!validId(d.owner)) fail(400, 'Обновите страницу.');
  if (d.action === 'begin') {
    if (!validId(d.id) || !validId(d.taskId) || !Number.isInteger(d.version))
      fail(400, 'Не удалось открыть задачу.');
    await db().batch([
      sql(
        `UPDATE attempts SET ready_id=?,selected_task_id=?,state_version=state_version+1 WHERE id=? AND finished_at IS NULL AND deadline_at>? AND state_version=? AND ready_id IS NULL AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND room_id=attempts.room_id)`,
        d.id,
        d.taskId,
        a.id,
        now,
        d.version,
        d.taskId,
      ),
      sql(
        `INSERT OR IGNORE INTO attempt_intervals(id,attempt_id,task_id,owner) SELECT ?,id,?,? FROM attempts WHERE id=? AND ready_id=?`,
        d.id,
        d.taskId,
        d.owner,
        a.id,
        d.id,
      ),
    ]);
    const next = await fresh(a.id);
    if (next.ready_id !== d.id)
      fail(409, 'Попытка открыта в другой вкладке. Проверьте состояние.', 'session');
  } else if (d.action === 'adopt-legacy') {
    await sql(
      `UPDATE attempt_intervals SET owner=? WHERE attempt_id=? AND owner='legacy' AND closed_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NULL AND deadline_at>?)`,
      d.owner,
      a.id,
      a.id,
      now,
    ).run();
  } else if (d.action === 'arm') {
    const existing = await sql(
      'SELECT started_at FROM attempt_intervals WHERE id=? AND attempt_id=? AND owner=?',
      d.id,
      a.id,
      d.owner,
    ).first<{ started_at: number | null }>();
    if (existing?.started_at != null) return snapshot(await fresh(a.id), r);
    if (!Number.isSafeInteger(d.startedAt) || Math.abs(d.startedAt - now) > 60000)
      fail(400, 'Не удалось запустить время.');
    await sql(
      `UPDATE attempt_intervals SET started_at=? WHERE id=? AND attempt_id=? AND owner=? AND started_at IS NULL AND closed_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND ready_id=? AND finished_at IS NULL AND deadline_at>?)`,
      d.startedAt,
      d.id,
      a.id,
      d.owner,
      a.id,
      d.id,
      now,
    ).run();
  } else if (d.action === 'checkpoint') {
    if (
      !Number.isSafeInteger(d.durationMs) ||
      d.durationMs < 0 ||
      d.durationMs > Math.min(LIMITS.attemptTtlMs, now - a.started_at + 60000)
    )
      fail(400, 'Не удалось сохранить время.');
    await sql(
      `UPDATE attempt_intervals SET duration_ms=MAX(duration_ms,?) WHERE id=? AND attempt_id=? AND owner=? AND closed_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND ready_id=? AND finished_at IS NULL AND deadline_at>?)`,
      d.durationMs,
      d.id,
      a.id,
      d.owner,
      a.id,
      d.id,
      now,
    ).run();
  } else if (d.action === 'close') {
    if (
      !Number.isSafeInteger(d.durationMs) ||
      d.durationMs < 0 ||
      d.durationMs > LIMITS.attemptTtlMs ||
      d.durationMs > now - a.started_at + 60000
    )
      fail(400, 'Не удалось сохранить время.');
    await db().batch([
      sql(
        `UPDATE attempt_intervals SET duration_ms=?,closed_at=? WHERE id=? AND attempt_id=? AND owner=? AND closed_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND ready_id=? AND finished_at IS NULL AND deadline_at>?)`,
        d.durationMs,
        now,
        d.id,
        a.id,
        d.owner,
        a.id,
        d.id,
        now,
      ),
      sql(
        `UPDATE attempts SET ready_id=NULL,state_version=state_version+1 WHERE id=? AND ready_id=? AND EXISTS(SELECT 1 FROM attempt_intervals WHERE id=? AND closed_at IS NOT NULL)`,
        a.id,
        d.id,
        d.id,
      ),
    ]);
    const closed = await sql(
      'SELECT * FROM attempt_intervals WHERE id=? AND attempt_id=?',
      d.id,
      a.id,
    ).first<Interval>();
    if (
      !closed ||
      closed.owner !== d.owner ||
      closed.closed_at === null ||
      closed.duration_ms !== d.durationMs
    )
      fail(409, 'Время уже сохранено в другой вкладке. Проверьте состояние.', 'session');
  } else if (d.action === 'takeover') {
    // Close the former owner's running wall interval before handing over. It cannot append later.
    await db().batch([
      sql(
        `UPDATE attempt_intervals SET closed_at=? WHERE attempt_id=? AND closed_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND state_version=? AND finished_at IS NULL AND deadline_at>?)`,
        now,
        a.id,
        a.id,
        d.version,
        now,
      ),
      sql(
        `UPDATE attempts SET ready_id=NULL,state_version=state_version+1,timing_incomplete=CASE WHEN ready_id IS NOT NULL THEN 1 ELSE timing_incomplete END WHERE id=? AND state_version=? AND finished_at IS NULL AND deadline_at>?`,
        a.id,
        d.version,
        now,
      ),
    ]);
  } else if (d.action === 'cancel') {
    if (!validId(d.requestId)) fail(400, 'Не удалось проверить отправку.');
    await sql(
      `INSERT OR IGNORE INTO cancelled_answers(attempt_id,request_id) SELECT id,? FROM attempts WHERE id=? AND finished_at IS NULL AND NOT EXISTS(SELECT 1 FROM attempt_operations WHERE attempt_id=? AND request_id=?)`,
      d.requestId,
      a.id,
      a.id,
      d.requestId,
    ).run();
  } else if (d.action === 'finish') {
    if (!validId(d.requestId)) fail(400, 'Не удалось завершить тест.');
    await db().batch([
      sql(
        `UPDATE attempts SET finished_at=?,result_expires_at=?,finish_reason='manual',finish_request_id=?,state_version=state_version+1 WHERE id=? AND finished_at IS NULL AND deadline_at>? AND ready_id IS NULL AND state_version=?`,
        now,
        now + LIMITS.resultTtlMs,
        d.requestId,
        a.id,
        now,
        d.version,
      ),
      ...retention(a.id),
    ]);
    if ((await fresh(a.id)).finished_at === null)
      fail(409, 'Попытка изменилась. Проверьте состояние перед завершением.', 'session');
  } else fail(400, 'Не удалось выполнить действие.');
  return snapshot(await fresh(a.id), r);
}

export async function journeySubmit(req: Request, a: Attempt, r: Room) {
  const { data: d, file } = await answerBody<JourneyAnswer>(req);
  if (
    !validId(d.requestId) ||
    !validId(d.taskId) ||
    !Number.isInteger(d.version) ||
    !Number.isInteger(d.revision) ||
    typeof d.answer !== 'string' ||
    !d.answer.trim() ||
    d.answer.length > 200 ||
    !['keep', 'replace', 'remove'].includes(d.photoAction)
  )
    fail(400, 'Введите ответ от 1 до 200 символов.');
  const task = (await roomTasks(r.id)).find((t) => t.id === d.taskId);
  if (!task) fail(404, 'Задача не найдена.');
  let bytes: Uint8Array | null = null,
    mime: string | null = null,
    digest: string | null = null;
  if (d.photoAction === 'replace') {
    if (!file || !file.size || file.size > LIMITS.fileBytes) fail(413, 'Фото решения — до 3 МБ.');
    bytes = new Uint8Array(await file!.arrayBuffer());
    mime = inspectImage(bytes)?.mime || null;
    if (!mime || mime !== file!.type) fail(415, 'Выберите JPEG, PNG или WebP.');
    digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  } else if (file) fail(400, 'Повторите выбор фото.');
  const payloadHash = await hash(JSON.stringify({ ...d, answer: d.answer.trim(), digest }));
  const prior = await sql(
    'SELECT payload_hash FROM attempt_operations WHERE attempt_id=? AND request_id=?',
    a.id,
    d.requestId,
  ).first<{ payload_hash: string }>();
  if (prior) {
    if (prior.payload_hash !== payloadHash)
      fail(409, 'Эта отправка уже использована. Проверьте состояние.');
    return snapshot(await fresh(a.id), r);
  }
  const old = await sql(
    'SELECT * FROM answers WHERE attempt_id=? AND task_id=?',
    a.id,
    d.taskId,
  ).first<Answer>();
  let key = d.photoAction === 'keep' ? old?.solution_key || null : null;
  if (d.photoAction === 'keep') {
    mime = old?.solution_mime || null;
    digest = old?.solution_digest || null;
  }
  const candidate = bytes ? `solutions/${a.id}/${d.requestId}/${random()}` : null;
  if (candidate) {
    key = candidate;
    await sql('INSERT INTO blobs(key,expires_at) VALUES(?,?)', key, Date.now() + 3600000).run();
    try {
      await bucket().put(key, bytes!, { httpMetadata: { contentType: mime! } });
    } catch {
      await discardUnusedPhoto(candidate);
      fail(503, 'Не удалось загрузить фото. Повторите отправку.', 'photo-upload');
    }
  }
  const token = random(),
    now = Date.now(),
    slot = (JSON.parse(a.order_json) as string[]).indexOf(d.taskId);
  const applied = `EXISTS(SELECT 1 FROM attempt_operations WHERE attempt_id=? AND request_id=? AND token=?)`;
  try {
    await db().batch([
      sql(
        `INSERT OR IGNORE INTO attempt_operations(attempt_id,request_id,payload_hash,token) SELECT id,?,?,? FROM attempts WHERE id=? AND timing_version=3 AND finished_at IS NULL AND deadline_at>? AND ready_id IS NULL AND state_version=? AND COALESCE((SELECT revision FROM answers WHERE attempt_id=? AND task_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM cancelled_answers WHERE attempt_id=? AND request_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM blobs WHERE key=? AND state='live'))`,
        d.requestId,
        payloadHash,
        token,
        a.id,
        now,
        d.version,
        a.id,
        d.taskId,
        d.revision,
        a.id,
        d.requestId,
        candidate,
        candidate,
      ),
      sql(
        `INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms,received_at,solution_key,solution_mime,solution_digest,revision) SELECT ?,?,?,?,?,?,?,?,?,0,?,?,?,?,? WHERE ${applied} ON CONFLICT(attempt_id,task_id) DO UPDATE SET request_id=excluded.request_id,answer=excluded.answer,correct=excluded.correct,answered_at=excluded.answered_at,received_at=excluded.received_at,solution_key=excluded.solution_key,solution_mime=excluded.solution_mime,solution_digest=excluded.solution_digest,revision=excluded.revision`,
        random(),
        a.id,
        slot,
        d.taskId,
        d.requestId,
        d.answer.trim(),
        normalizeAnswer(task!.answer) === normalizeAnswer(d.answer) ? 1 : 0,
        a.started_at,
        now,
        now,
        key,
        mime,
        digest,
        d.revision + 1,
        a.id,
        d.requestId,
        token,
      ),
      sql(
        `UPDATE attempts SET position=(SELECT COUNT(*) FROM answers WHERE attempt_id=?),state_version=state_version+1 WHERE id=? AND ${applied}`,
        a.id,
        a.id,
        a.id,
        d.requestId,
        token,
      ),
      sql(
        `UPDATE attempts SET finished_at=?,result_expires_at=?,finish_reason='completed' WHERE id=? AND finished_at IS NULL AND position=? AND ${applied}`,
        now,
        now + LIMITS.resultTtlMs,
        a.id,
        r.count,
        a.id,
        d.requestId,
        token,
      ),
      sql(
        `UPDATE blobs SET expires_at=MAX(expires_at,?) WHERE key=? AND ${applied}`,
        a.deadline_at + LIMITS.resultTtlMs,
        key,
        a.id,
        d.requestId,
        token,
      ),
      sql(
        `UPDATE blobs SET expires_at=0 WHERE key=? AND NOT EXISTS(SELECT 1 FROM answers WHERE solution_key=?)`,
        old?.solution_key || null,
        old?.solution_key || null,
      ),
      ...retention(a.id),
    ]);
  } catch (e) {
    await discardUnusedPhoto(candidate);
    throw e;
  }
  const saved = await sql(
    'SELECT payload_hash FROM attempt_operations WHERE attempt_id=? AND request_id=?',
    a.id,
    d.requestId,
  ).first<{ payload_hash: string }>();
  await discardUnusedPhoto(candidate);
  if (saved?.payload_hash !== payloadHash) {
    const next = await fresh(a.id);
    if (next.finished_at !== null) return snapshot(next, r);
    fail(409, 'Попытка изменилась. Проверьте состояние; черновик сохранён.', 'conflict');
  }
  await discardUnusedPhoto(old?.solution_key || null);
  return snapshot(await fresh(a.id), r);
}
