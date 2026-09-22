import { LIMITS } from './limits';
import {
  assertAccessTime,
  attempt,
  cancelAnswer,
  finish,
  ready,
  snapshot,
  start,
  submit,
} from './server/attempts';
import { cleanup } from './server/cleanup';
import { finalizeDue } from './server/completion';
import {
  fail,
  hash,
  HttpError,
  limit,
  room,
  roomPublic,
  roomTasks,
  secret,
  sql,
  validId,
  validKey,
  type RequestTrace,
  type Room,
  type Task,
} from './server/context';
import { createRoom } from './server/rooms';
import { bucket } from './server/storage';
export { cleanup };
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
export async function handle(req: Request) {
  const trace: RequestTrace = { id: crypto.randomUUID(), phase: 'request', started: Date.now() };
  try {
    const url = new URL(req.url);
    const p = url.pathname.split('/').filter(Boolean).slice(1);
    const method = req.method;
    if (method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== url.origin)
      fail(403, 'Откройте ссылку TaskBattle в браузере и повторите действие.');
    if (req.headers.get('sec-fetch-site') === 'cross-site')
      fail(403, 'Откройте ссылку TaskBattle в браузере и повторите действие.');
    if (p[0] === 'health') return Response.json({ ok: true }, { headers });
    const ip = await hash(
      (req.headers.get('cf-connecting-ip') || 'local') +
        ':' +
        new Date().toISOString().slice(0, 10),
    );
    await limit('api:' + ip, 900, 60000);
    let result: unknown;
    if (p[0] === 'cleanup' && method === 'POST') {
      await limit('cleanup:global', 1, 60000);
      result = await cleanup();
    } else if (p[0] === 'rooms' && p.length === 1 && method === 'POST')
      result = await createRoom(req, ip, trace);
    else if (p[0] === 'creations' && p.length === 2 && method === 'GET') {
      const key = req.headers.get('x-teacher-key') || '';
      if (!validId(p[1]) || !validKey(key)) fail(404, 'Создание комнаты не найдено.');
      const saved = await sql(
        'SELECT * FROM rooms WHERE request_id=? AND teacher_hash=?',
        p[1],
        await hash(key),
      ).first<Room>();
      if (!saved) fail(404, 'Создание комнаты не найдено.');
      const r = await room(saved!.id);
      result = { roomId: r.id, teacherKey: key, expiresAt: r.expires_at };
    } else if (p[0] === 'rooms' && p[1]) {
      const r = await room(p[1], p[2] === 'teacher' && method === 'GET');
      if (p.length === 2 && method === 'GET') result = roomPublic(r, await roomTasks(r.id));
      else if (p[2] === 'start' && method === 'POST') result = await start(req, r, ip);
      else if (p[2] === 'teacher' && method === 'GET') {
        await secret(req, r.teacher_hash, 'x-teacher-key');
        await finalizeDue(r.id, LIMITS.attempts);
        const list = (
          await sql(
            'SELECT id,started_at,deadline_at,finish_reason,finished_at,position,COALESCE(result_expires_at,finished_at+?) AS result_expires_at FROM attempts WHERE room_id=? AND (finished_at IS NULL OR COALESCE(result_expires_at,finished_at+?)>?) ORDER BY started_at,id',
            LIMITS.resultTtlMs,
            r.id,
            LIMITS.resultTtlMs,
            Date.now(),
          ).all<{
            id: string;
            started_at: number;
            finished_at: number | null;
            position: number;
            deadline_at: number;
            finish_reason: string | null;
            result_expires_at: number | null;
          }>()
        ).results;
        if (!list.length && r.expires_at <= Date.now()) fail(410, 'Срок хранения результата истёк');
        result = {
          ...roomPublic(r, []),
          roomExpiresAt: r.expires_at,
          roomClosed: r.expires_at <= Date.now(),
          expiresAt: Math.max(
            r.expires_at,
            ...list.map((a) => a.result_expires_at || a.deadline_at + LIMITS.resultTtlMs),
          ),
          attempts: list.map((a, i) => ({
            id: a.id,
            number: i + 1,
            startedAt: a.started_at,
            finishedAt: a.finished_at,
            position: a.position,
            finishReason: a.finish_reason,
            resultExpiresAt: a.result_expires_at,
          })),
        };
      } else if (p[2] === 'photos' && p[3] && method === 'GET') {
        const t = await sql(
          'SELECT * FROM tasks WHERE id=? AND room_id=?',
          p[3],
          r.id,
        ).first<Task>();
        if (!t) fail(404, 'Фотография не найдена.');
        const object = await bucket().get(t!.file_key);
        if (!object) fail(404, 'Фотография недоступна.');
        await room(r.id);
        return new Response(object!.body, {
          headers: { ...headers, 'Content-Type': t!.mime, 'Content-Disposition': 'inline' },
        });
      } else fail(404, 'Страница не найдена.');
    } else if (p[0] === 'attempts' && p[1]) {
      const teacher = p[2] === 'report' || req.headers.has('x-teacher-key');
      const { a, r } = await attempt(p[1], req, teacher);
      if (method === 'GET' && (p[2] === 'photos' || p[2] === 'solutions') && p.length === 4) {
        let file: { file_key: string; mime: string } | null;
        if (p[2] === 'photos')
          file = await sql(
            'SELECT file_key,mime FROM tasks WHERE room_id=? AND id=?',
            r.id,
            p[3],
          ).first();
        else
          file = await sql(
            'SELECT solution_key AS file_key,solution_mime AS mime FROM answers WHERE attempt_id=? AND task_id=? AND solution_key IS NOT NULL',
            a.id,
            p[3],
          ).first();
        if (!file) fail(404, 'Фотография не найдена.');
        const object = await bucket().get(file!.file_key);
        if (!object) fail(404, 'Фотография недоступна.');
        await assertAccessTime(a, r);
        return new Response(object!.body, {
          headers: { ...headers, 'Content-Type': file!.mime, 'Content-Disposition': 'inline' },
        });
      } else if (method === 'GET' && (p.length === 2 || (p[2] === 'report' && p.length === 3)))
        result = await snapshot(a, r);
      else if (p[2] === 'ready' && method === 'POST' && !teacher) result = await ready(req, a, r);
      else if (p[2] === 'cancel-answer' && method === 'POST' && !teacher)
        result = await cancelAnswer(req, a, r);
      else if (p[2] === 'answers' && method === 'POST' && !teacher)
        result = await submit(req, a, r, trace);
      else if (p[2] === 'finish' && method === 'POST' && !teacher) result = await finish(req, a, r);
      else fail(404, 'Страница не найдена.');
    } else fail(404, 'Страница не найдена.');
    return Response.json(result, { headers });
  } catch (e) {
    if (e instanceof HttpError)
      return Response.json({ error: e.message, code: e.code }, { status: e.status, headers });
    console.error(
      JSON.stringify({
        event: 'taskbattle-request-failed',
        traceId: trace.id,
        phase: trace.phase,
        elapsedMs: Date.now() - trace.started,
        errorName: e instanceof Error ? e.name : 'unknown',
      }),
    );
    return Response.json(
      {
        error:
          trace.phase === 'commit-answer'
            ? 'Не удалось сохранить ответ. Повторите отправку.'
            : 'Не удалось выполнить действие. Попробуйте ещё раз.',
        code: trace.phase === 'commit-answer' ? 'answer-save' : 'request',
        traceId: trace.id,
      },
      { status: 503, headers },
    );
  }
}
