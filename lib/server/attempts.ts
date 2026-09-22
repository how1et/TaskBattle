import { inspectImage } from '../image-file';
import { LIMITS } from '../limits';
import { normalizeAnswer, summarize } from '../normalization';
import {
  body,
  db,
  fail,
  hash,
  HttpError,
  limit,
  random,
  room,
  roomTasks,
  secret,
  sql,
  validId,
  validKey,
  type Attempt,
  type RequestTrace,
  type Room,
  type Task,
} from './context';
import { bucket, discardUnusedPhoto } from './storage';
import { expireAttempt, finishAttempt } from './completion';
const RESULT_TTL = LIMITS.resultTtlMs;
type Answer = {
  task_id: string;
  position: number;
  request_id: string;
  answer: string;
  correct: number;
  duration_ms: number;
  started_at: number;
  answered_at: number;
  ready_id: string | null;
  solution_key: string | null;
  solution_mime: string | null;
  solution_digest: string | null;
};
export const resultExpiry = (a: Attempt) =>
  a.result_expires_at ?? (a.finished_at ?? 0) + RESULT_TTL;
export async function assertAccessTime(a: Attempt, _r: Room) {
  // An old Worker may create a row between the data migration and rollout.
  if (a.deadline_at == null) {
    await sql(
      'UPDATE attempts SET deadline_at=started_at+? WHERE id=? AND deadline_at IS NULL',
      LIMITS.attemptTtlMs,
      a.id,
    ).run();
    Object.assign(a, await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>());
  }
  if (a.finished_at === null && a.deadline_at <= Date.now()) {
    await expireAttempt(a.id);
    Object.assign(a, await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>());
  }
  if (a.finished_at !== null) {
    if (resultExpiry(a) <= Date.now()) fail(410, 'Срок хранения результата истёк');
  }
}
export async function attempt(id: string, req: Request, teacher = false) {
  if (!validId(id)) fail(404, 'Попытка не найдена.');
  const a = await sql('SELECT * FROM attempts WHERE id=?', id).first<Attempt>();
  if (!a) {
    const old = await sql('SELECT * FROM expired_attempts WHERE id=?', id).first<{
      secret_hash: string;
      teacher_hash: string;
      reason: string;
    }>();
    if (old) {
      await secret(
        req,
        teacher ? old.teacher_hash : old.secret_hash,
        teacher ? 'x-teacher-key' : 'x-attempt-key',
      );
      fail(
        410,
        old.reason === 'result' ? 'Срок хранения результата истёк' : 'Срок действия комнаты истёк',
      );
    }
    fail(404, 'Попытка не найдена. Проверьте ссылку.');
  }
  const r = await room(a!.room_id, true);
  await secret(
    req,
    teacher ? r.teacher_hash : a!.secret_hash,
    teacher ? 'x-teacher-key' : 'x-attempt-key',
  );
  await assertAccessTime(a!, r);
  return { a: a!, r };
}
export async function snapshot(a: Attempt, r: Room) {
  await assertAccessTime(a, r);
  const ts = await roomTasks(r.id),
    ids: string[] = JSON.parse(a.order_json);
  const rows = (
    await sql('SELECT * FROM answers WHERE attempt_id=? ORDER BY position', a.id).all<Answer>()
  ).results;
  const fresh = (await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!;
  if (
    fresh.position !== a.position ||
    fresh.finished_at !== a.finished_at ||
    fresh.ready_id !== a.ready_id
  )
    return snapshot(fresh, r);
  const completedMs = rows.reduce((sum, row) => sum + row.duration_ms, 0);
  const active = a.timing_version === 1 || a.ready_id !== null;
  const base = {
    attemptId: a.id,
    roomId: r.id,
    title: r.title,
    roomExpiresAt: r.expires_at,
    expiresAt: a.finished_at !== null ? resultExpiry(a) : a.deadline_at,
    deadlineAt: a.deadline_at,
    finishReason: a.finish_reason,
    timingIncomplete: !!a.timing_incomplete,
    unfinishedMs: a.unfinished_ms,
    resultExpiresAt: a.finished_at !== null ? resultExpiry(a) : null,
    count: r.count,
    position: a.position,
    startedAt: a.started_at,
    taskStartedAt: active ? a.task_started_at : null,
    readyId: a.timing_version === 1 ? 'legacy' : a.ready_id,
    timingVersion: a.timing_version,
    completedMs,
    finishedAt: a.finished_at,
    serverNow: Date.now(),
    tasks: ids.map((id) => {
      const t = ts.find((t) => t.id === id)!;
      return { id: t.id, ordinal: t.ordinal, photo: `/api/attempts/${a.id}/photos/${t.id}` };
    }),
  };
  if (a.finished_at === null) return base;
  const report = ts.map((t) => {
    const answer = rows.find((v) => v.task_id === t.id);
    return {
      id: t.id,
      ordinal: t.ordinal,
      photo: `/api/attempts/${a.id}/photos/${t.id}`,
      answer: answer?.answer ?? null,
      submitted: !!answer,
      correctAnswer: t.answer,
      correct: answer ? !!answer.correct : null,
      durationMs: answer?.duration_ms ?? null,
      startedAt: answer?.started_at ?? null,
      answeredAt: answer?.answered_at ?? null,
      solutionPhoto: answer?.solution_key ? `/api/attempts/${a.id}/solutions/${t.id}` : null,
    };
  });
  return { ...base, report, summary: summarize(report, undefined, a.unfinished_ms) };
}
export async function start(req: Request, r: Room, ip: string) {
  const data = await body(req);
  if (!validId(data.attemptId) || !validKey(data.attemptKey))
    fail(400, 'Не удалось начать попытку. Откройте ссылку на занятие и нажмите «Старт».');
  const secretHash = await hash(data.attemptKey),
    old = await sql('SELECT * FROM attempts WHERE id=?', data.attemptId).first<Attempt>();
  if (old) {
    if (old.room_id !== r.id || old.secret_hash !== secretHash) fail(403, 'Нет доступа к попытке.');
    return snapshot(old, r);
  }
  await limit('start:' + ip, LIMITS.attempts, 3600000);
  const ids = (await roomTasks(r.id)).map((t) => t.id);
  const now = Date.now();
  await sql(
    'INSERT INTO attempts (id,room_id,secret_hash,order_json,position,started_at,deadline_at,task_started_at,timing_version) SELECT ?,?,?,?,0,?,?,0,2 WHERE (SELECT count(*) FROM attempts WHERE room_id=?)<? AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND expires_at>?) ON CONFLICT(id) DO NOTHING',
    data.attemptId,
    r.id,
    secretHash,
    JSON.stringify(ids),
    now,
    now + LIMITS.attemptTtlMs,
    r.id,
    LIMITS.attempts,
    r.id,
    now,
  ).run();
  const a = await sql('SELECT * FROM attempts WHERE id=?', data.attemptId).first<Attempt>();
  if (!a) fail(429, 'В этой комнате уже 120 попыток или срок комнаты истёк.');
  if (a!.secret_hash !== secretHash || a!.room_id !== r.id) fail(403, 'Нет доступа к попытке.');
  return snapshot(a!, r);
}
export async function ready(req: Request, a: Attempt, r: Room) {
  const data = await body(req),
    ids: string[] = JSON.parse(a.order_json),
    now = Date.now();
  await assertAccessTime(a, r);
  if (a.finished_at !== null) return snapshot(a, r);
  if (data.position !== a.position || data.taskId !== ids[a.position])
    fail(409, 'Задача уже изменена. Проверьте отправку.');
  if (a.timing_version === 1) return snapshot(a, r);
  if (
    !validId(data.readyId) ||
    !Number.isSafeInteger(data.startedAt) ||
    data.startedAt < r.created_at ||
    data.startedAt > now + 60000
  )
    fail(400, 'Не удалось начать задачу. Обновите страницу.');
  await sql(
    'UPDATE attempts SET ready_id=?,task_started_at=? WHERE id=? AND position=? AND ready_id IS NULL AND finished_at IS NULL AND deadline_at>?',
    data.readyId,
    data.startedAt,
    a.id,
    a.position,
    now,
  ).run();
  const fresh = await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>();
  return snapshot(fresh!, r);
}
export async function finish(req: Request, a: Attempt, r: Room) {
  const data = await body(req);
  await assertAccessTime(a, r);
  if (a.finished_at !== null) return snapshot(a, r);
  if (
    !validId(data.requestId) ||
    !Number.isInteger(data.position) ||
    data.position < 0 ||
    data.position >= r.count ||
    !Number.isSafeInteger(data.durationMs) ||
    data.durationMs < 0 ||
    data.durationMs > LIMITS.attemptTtlMs ||
    data.durationMs > Math.max(0, Date.now() - a.started_at) + 60000
  )
    fail(400, 'Не удалось завершить тест. Обновите страницу и повторите.');
  await finishAttempt(a, data.requestId, data.position, data.durationMs);
  return snapshot((await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!, r);
}
type AnswerInput = {
  requestId: string;
  taskId: string;
  position: number;
  answer: string;
  durationMs: number;
  readyId: string;
};
async function answerBody(req: Request): Promise<{ data: AnswerInput; file: File | null }> {
  if (!req.headers.get('content-type')?.startsWith('multipart/form-data'))
    return { data: await body(req), file: null };
  if (Number(req.headers.get('content-length')) > LIMITS.fileBytes + 16384)
    fail(413, 'Фото решения — до 3 МБ.');
  let bytes = 0;
  const stream = req.body?.pipeThrough(
    new TransformStream({
      transform(chunk, c) {
        bytes += chunk.byteLength;
        if (bytes > LIMITS.fileBytes + 16384) throw new HttpError(413, 'Фото решения — до 3 МБ.');
        c.enqueue(chunk);
      },
    }),
  );
  if (!stream) fail(400, 'Не удалось отправить ответ. Повторите.');
  const form = await new Response(stream, {
    headers: { 'content-type': req.headers.get('content-type')! },
  }).formData();
  let data!: AnswerInput;
  try {
    data = JSON.parse(String(form.get('payload')));
    if (!data || typeof data !== 'object') throw Error('Invalid payload');
  } catch {
    fail(400, 'Не удалось отправить ответ. Повторите.');
  }
  const file = form.get('solution');
  if (form.getAll('solution').length > 1 || (file !== null && !(file instanceof File)))
    fail(400, 'Можно прикрепить одно фото решения.');
  return { data, file: file as File | null };
}
export async function cancelAnswer(req: Request, a: Attempt, r: Room) {
  const data = await body(req),
    ids: string[] = JSON.parse(a.order_json);
  if (
    !validId(data.requestId) ||
    !Number.isInteger(data.position) ||
    ids[data.position] !== data.taskId
  )
    fail(400, 'Не удалось проверить отправку. Повторите действие.');
  // This statement and submit's conditional INSERT serialize in D1. A late
  // upload cannot commit once its request was cancelled for editing.
  await sql(
    'INSERT INTO cancelled_answers(attempt_id,request_id) SELECT id,? FROM attempts WHERE id=? AND position=? AND finished_at IS NULL AND deadline_at>? AND NOT EXISTS(SELECT 1 FROM answers WHERE attempt_id=? AND request_id=?) ON CONFLICT DO NOTHING',
    data.requestId,
    a.id,
    data.position,
    Date.now(),
    a.id,
    data.requestId,
  ).run();
  const fresh = (await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!;
  const cancelled = !!(await sql(
    'SELECT request_id FROM cancelled_answers WHERE attempt_id=? AND request_id=?',
    a.id,
    data.requestId,
  ).first());
  return {
    cancelled: cancelled && fresh.position === data.position && fresh.finished_at === null,
    snapshot: await snapshot(fresh, r),
  };
}
export async function submit(req: Request, a: Attempt, r: Room, trace: RequestTrace) {
  trace.phase = 'validate-answer';
  const { data, file } = await answerBody(req);
  await assertAccessTime(a, r);
  if (
    !validId(data.requestId) ||
    typeof data.answer !== 'string' ||
    !data.answer.trim() ||
    data.answer.length > LIMITS.answerLength ||
    !Number.isInteger(data.position)
  )
    fail(400, 'Введите ответ от 1 до 200 символов.');
  let digest: string | null = null,
    mime: string | null = null,
    bytes: Uint8Array | null = null;
  if (file) {
    if (!file.size || file.size > LIMITS.fileBytes) fail(413, 'Фото решения — до 3 МБ.');
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = inspectImage(bytes)?.mime || null;
    if (!mime || mime !== file.type || !/\.(jpe?g|png|webp)$/i.test(file.name))
      fail(415, 'Выберите JPEG, PNG или WebP. HEIC/HEIF сначала сохраните как JPEG.');
    digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  }
  if (
    a.timing_version === 2 &&
    (!Number.isSafeInteger(data.durationMs) ||
      data.durationMs < 0 ||
      data.durationMs > LIMITS.attemptTtlMs ||
      !validId(data.readyId))
  )
    fail(400, 'Не удалось отправить время. Обновите страницу.');
  const matches = (row: Answer) =>
    row.answer === data.answer.trim() &&
    row.position === data.position &&
    row.task_id === data.taskId &&
    row.solution_digest === digest &&
    (a.timing_version === 1 ||
      (row.duration_ms === data.durationMs && row.ready_id === data.readyId));
  const prior = await sql(
    'SELECT * FROM answers WHERE attempt_id=? AND request_id=?',
    a.id,
    data.requestId,
  ).first<Answer>();
  if (prior) {
    if (!matches(prior)) fail(409, 'Уже принят другой ответ. Проверьте отправку.');
    return snapshot((await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!, r);
  }
  if (
    await sql(
      'SELECT request_id FROM cancelled_answers WHERE attempt_id=? AND request_id=?',
      a.id,
      data.requestId,
    ).first()
  )
    fail(409, 'Этот вариант отменён. Отправьте изменённый ответ.', 'cancelled');
  const ids: string[] = JSON.parse(a.order_json);
  if (
    a.finished_at !== null ||
    data.position !== a.position ||
    data.taskId !== ids[a.position] ||
    (a.timing_version === 2 && (!a.ready_id || a.ready_id !== data.readyId))
  )
    fail(409, 'Задача уже изменена. Проверьте отправку.');
  const duration =
    a.timing_version === 2 ? data.durationMs : Math.max(0, Date.now() - a.task_started_at);
  if (duration > Math.max(0, Date.now() - a.task_started_at) + 60000)
    fail(400, 'Не удалось отправить время. Обновите страницу.');
  const t = await sql(
    'SELECT * FROM tasks WHERE id=? AND room_id=?',
    data.taskId,
    r.id,
  ).first<Task>();
  if (!t) fail(404, 'Задача не найдена.');
  let solutionKey: string | null = null;
  if (file && bytes && mime && digest) {
    solutionKey = `solutions/${a.id}/${data.requestId}/${random()}`;
    await sql(
      "INSERT INTO blobs(key,expires_at,state) SELECT ?,?,'live' FROM attempts WHERE id=? AND finished_at IS NULL AND deadline_at>? ON CONFLICT(key) DO NOTHING",
      solutionKey,
      Date.now() + 3600000,
      a.id,
      Date.now(),
    ).run();
    const lease = await sql(
      "SELECT key FROM blobs WHERE key=? AND state='live'",
      solutionKey,
    ).first();
    if (!lease)
      return snapshot((await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!, r);
    trace.phase = 'store-solution-photo';
    try {
      await bucket().put(solutionKey, bytes, { httpMetadata: { contentType: mime } });
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: 'solution-upload-failed',
          phase: trace.phase,
          errorName: e instanceof Error ? e.name : 'UnknownError',
        }),
      );
      await discardUnusedPhoto(solutionKey);
      fail(503, 'Не удалось загрузить фото. Повторите отправку.', 'photo-upload');
    }
  }
  const now = Date.now(),
    end = a.task_started_at + duration;
  trace.phase = 'commit-answer';
  try {
    await db().batch([
      sql(
        `INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms,ready_id,received_at,solution_key,solution_mime,solution_digest)
        SELECT ?,id,position,?,?,?,?,task_started_at,?,?,?,?,?,?,? FROM attempts WHERE id=? AND position=? AND finished_at IS NULL AND (timing_version=1 OR ready_id=?) AND deadline_at>? AND (? IS NULL OR EXISTS(SELECT 1 FROM blobs WHERE key=? AND state='live')) AND NOT EXISTS(SELECT 1 FROM cancelled_answers WHERE attempt_id=attempts.id AND request_id=?) ON CONFLICT DO NOTHING`,
        random(),
        data.taskId,
        data.requestId,
        data.answer.trim(),
        normalizeAnswer(t!.answer) === normalizeAnswer(data.answer) ? 1 : 0,
        end,
        duration,
        a.ready_id,
        now,
        solutionKey,
        mime,
        digest,
        a.id,
        data.position,
        a.ready_id,
        now,
        solutionKey,
        solutionKey,
        data.requestId,
      ),
      sql(
        `UPDATE attempts SET position=position+1,ready_id=NULL,task_started_at=CASE WHEN timing_version=1 THEN ? ELSE 0 END,finish_reason=CASE WHEN position+1=(SELECT count FROM rooms WHERE id=room_id) THEN 'completed' ELSE NULL END,finished_at=CASE WHEN position+1=? THEN ? ELSE NULL END,result_expires_at=CASE WHEN position+1=? THEN ? ELSE NULL END WHERE id=? AND position=? AND finished_at IS NULL AND EXISTS(SELECT 1 FROM answers WHERE attempt_id=? AND request_id=? AND position=?)`,
        now,
        r.count,
        now,
        r.count,
        now + RESULT_TTL,
        a.id,
        data.position,
        a.id,
        data.requestId,
        data.position,
      ),
      sql(
        `UPDATE blobs SET expires_at=MAX(expires_at,?) WHERE key=? AND state='live' AND EXISTS(SELECT 1 FROM answers WHERE attempt_id=? AND request_id=? AND solution_key=?)`,
        a.deadline_at,
        solutionKey,
        a.id,
        data.requestId,
        solutionKey,
      ),
      sql(
        `UPDATE blobs SET expires_at=MAX(expires_at,(SELECT result_expires_at FROM attempts WHERE id=?)) WHERE key IN(SELECT file_key FROM tasks WHERE room_id=?) AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NOT NULL)`,
        a.id,
        r.id,
        a.id,
      ),
      sql(
        `UPDATE blobs SET expires_at=(SELECT result_expires_at FROM attempts WHERE id=?) WHERE key IN(SELECT solution_key FROM answers WHERE attempt_id=?) AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NOT NULL)`,
        a.id,
        a.id,
        a.id,
      ),
    ]);
  } catch (e) {
    await discardUnusedPhoto(solutionKey);
    throw e;
  }
  const saved = await sql(
    'SELECT * FROM answers WHERE attempt_id=? AND request_id=?',
    a.id,
    data.requestId,
  ).first<Answer>();
  if (saved?.solution_key !== solutionKey) await discardUnusedPhoto(solutionKey);
  if (!saved || !matches(saved)) {
    const fresh = (await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!;
    await assertAccessTime(fresh, r);
    if (fresh.finished_at !== null) return snapshot(fresh, r);
    fail(409, 'Ответ изменён или уже принят. Проверьте отправку.', 'conflict');
  }
  return snapshot((await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>())!, r);
}
