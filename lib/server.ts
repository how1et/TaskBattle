import { env } from 'cloudflare:workers';
import { normalizeAnswer, summarize } from './normalization';
type Room = {
    id: string;
    title: string;
    teacher_hash: string;
    created_at: number;
    expires_at: number;
    count: number;
};
type Attempt = {
    id: string;
    room_id: string;
    secret_hash: string;
    order_json: string;
    position: number;
    started_at: number;
    task_started_at: number;
    finished_at: number | null;
};
type Task = {
    id: string;
    room_id: string;
    ordinal: number;
    file_key: string;
    mime: string;
    answer: string;
};
class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
const fail = (s: number, m: string): never => { throw new HttpError(s, m); };
const db = () => { if (!env.DB)
    fail(503, 'База временно недоступна. Попробуйте позже.'); return env.DB!; };
const bucket = () => { if (!env.BUCKET)
    fail(503, 'Хранилище временно недоступно. Попробуйте позже.'); return env.BUCKET!; };
const sql = (query: string, ...args: (string | number | null)[]) => db().prepare(query).bind(...args);
const random = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const validKey = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(v);
const validId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{20,100}$/.test(v);
async function secret(req: Request, expected: string, header = 'x-attempt-key') { const key = req.headers.get(header) || ''; if (!validKey(key) || await hash(key) !== expected)
    fail(403, 'Нет доступа. Откройте полную секретную ссылку.'); }
async function room(id: string) { if (!validId(id))
    fail(404, 'Комната не найдена.'); const r = await sql('SELECT * FROM rooms WHERE id = ?', id).first<Room>(); if (!r) {
    const stamp = parseInt(id.split('.')[1] || '', 36);
    if (Number.isFinite(stamp) && stamp < Date.now())
        fail(410, 'Срок действия комнаты истёк');
    fail(404, 'Комната не найдена. Проверьте ссылку.');
} if (r!.expires_at <= Date.now())
    fail(410, 'Срок действия комнаты истёк'); return r!; }
async function roomTasks(id: string) { return (await sql('SELECT * FROM tasks WHERE room_id = ? ORDER BY ordinal', id).all<Task>()).results; }
const photo = (r: string, t: string) => `/api/rooms/${r}/photos/${t}`;
const roomPublic = (r: Room, ts: Task[]) => ({ roomId: r.id, title: r.title, count: r.count, createdAt: r.created_at, expiresAt: r.expires_at, tasks: ts.map(t => ({ id: t.id, ordinal: t.ordinal, photo: photo(r.id, t.id) })), serverNow: Date.now() });
async function limit(key: string, max: number, window: number) { const now = Date.now(); const fixed = Math.floor(now / window); const result = await sql('INSERT INTO rate_limits (key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 WHERE hits < ? RETURNING hits', key + ':' + fixed, (fixed + 1) * window, max).first(); if (!result)
    fail(429, 'Слишком много запросов. Подождите немного и повторите.'); }
async function body(req: Request) { if (Number(req.headers.get('content-length')) > 8192)
    fail(413, 'Слишком большой запрос.'); const reader = req.body?.getReader(); if (!reader)
    fail(400, 'Пустой запрос.'); let size = 0; let value = ''; const decoder = new TextDecoder(); while (true) {
    const chunk = await reader!.read();
    if (chunk.done)
        break;
    size += chunk.value.byteLength;
    if (size > 8192) {
        await reader!.cancel();
        fail(413, 'Слишком большой запрос.');
    }
    value += decoder.decode(chunk.value, { stream: true });
} try {
    return JSON.parse(value + decoder.decode());
}
catch {
    fail(400, 'Некорректный запрос.');
} }
function imageType(a: Uint8Array) { if (a.length < 12)
    return null; if (a[0] === 255 && a[1] === 216 && a[2] === 255)
    return 'image/jpeg'; if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => a[i] === v))
    return 'image/png'; if (String.fromCharCode(...a.slice(0, 4)) === 'RIFF' && String.fromCharCode(...a.slice(8, 12)) === 'WEBP')
    return 'image/webp'; return null; }
type RequestTrace = { id: string; phase: string; started: number };
async function createRoom(req: Request, ip: string, trace: RequestTrace) {
    trace.phase = 'parse-upload';
    if (Number(req.headers.get('content-length')) > 19 * 1024 * 1024)
        fail(413, 'Не больше 18 МБ фотографий на комнату.');
    if (!req.headers.get('content-type')?.startsWith('multipart/form-data'))
        fail(415, 'Нужны фотографии JPEG, PNG или WebP.');
    let bytes = 0;
    const stream = req.body?.pipeThrough(new TransformStream({ transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > 19 * 1024 * 1024)
            throw new HttpError(413, 'Не больше 18 МБ фотографий на комнату.'); controller.enqueue(chunk); } }));
    if (!stream)
        fail(400, 'Добавьте фотографии.');
    const form = await new Response(stream, { headers: { 'content-type': req.headers.get('content-type')! } }).formData();
    trace.phase = 'validate-room';
    const requestId = String(form.get('requestId') || '');
    const teacherKey = String(form.get('teacherKey') || '');
    if (!validId(requestId) || !validKey(teacherKey))
        fail(400, 'Обновите страницу и повторите создание.');
    const teacherHash = await hash(teacherKey);
    const existing = await sql('SELECT * FROM rooms WHERE request_id=?', requestId).first<Room>();
    if (existing) {
        if (existing.teacher_hash !== teacherHash)
            fail(409, 'Идентификатор создания уже используется.');
        await room(existing.id);
        return { roomId: existing.id, teacherKey, expiresAt: existing.expires_at };
    }
    await limit('create:' + ip, 5, 3600000);
    await limit('create:global', 100, 86400000);
    const title = String(form.get('title') || '').trim() || 'Занятие без названия';
    if (title.length > 100)
        fail(400, 'Название — не больше 100 символов.');
    let correct: unknown;
    try {
        correct = JSON.parse(String(form.get('answers')));
    }
    catch {
        fail(400, 'Укажите ответы на все задачи.');
    }
    const files = form.getAll('photos');
    if (files.length < 1 || files.length > 12 || !Array.isArray(correct) || correct.length !== files.length)
        fail(400, 'Нужно от 1 до 12 фотографий с ответами.');
    const values = correct as unknown[];
    if (values.some(a => typeof a !== 'string' || !a.trim() || a.length > 200))
        fail(400, 'Каждой задаче нужен ответ от 1 до 200 символов.');
    let total = 0;
    for (const file of files) {
        if (!(file instanceof File) || file.size === 0 || file.size > 3 * 1024 * 1024)
            fail(400, 'Каждая фотография должна быть от 1 байта до 3 МБ.');
        total += (file as File).size;
    }
    if (total > 18 * 1024 * 1024)
        fail(413, 'Не больше 18 МБ фотографий на комнату.');
    const checked: {
        file: File;
        mime: string;
    }[] = [];
    for (const file of files as File[]) {
        const mime = imageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
        if (!mime || mime !== file.type || !(/\.(jpe?g|png|webp)$/i.test(file.name)))
            fail(415, 'Файл не является фотографией JPEG, PNG или WebP.');
        checked.push({ file, mime: mime! });
    }
    const now = Date.now(), expires = now + 48 * 3600000, roomId = random() + '.' + expires.toString(36);
    const keys: string[] = [];
    const taskRows: Task[] = [];
    try {
        trace.phase = 'store-photos';
        for (let i = 0; i < checked.length; i++) {
            const t = random(), key = `rooms/${roomId}/${t}`;
            keys.push(key);
            await sql('INSERT INTO blobs (key,expires_at) VALUES (?,?)', key, now + 3600000).run();
            await bucket().put(key, checked[i].file.stream(), { httpMetadata: { contentType: checked[i].mime } });
            taskRows.push({ id: t, room_id: roomId, ordinal: i + 1, file_key: key, mime: checked[i].mime, answer: String(values[i]).trim() });
        }
        trace.phase = 'commit-room';
        await db().batch([sql('INSERT INTO rooms (id,request_id,title,teacher_hash,created_at,expires_at,count) VALUES (?,?,?,?,?,?,?)', roomId, requestId, title, teacherHash, now, expires, files.length), ...taskRows.map(t => sql('INSERT INTO tasks (id,room_id,ordinal,file_key,mime,answer) VALUES (?,?,?,?,?,?)', t.id, roomId, t.ordinal, t.file_key, t.mime, t.answer)), ...keys.map(k => sql('UPDATE blobs SET expires_at=? WHERE key=?', expires, k))]);
    }
    catch (error) {
        const prior = await sql('SELECT * FROM rooms WHERE request_id=?', requestId).first<Room>();
        if (prior?.id !== roomId) {
            await bucket().delete(keys);
            for (const k of keys)
                await sql('DELETE FROM blobs WHERE key=?', k).run();
        }
        if (prior && prior.teacher_hash === teacherHash)
            return { roomId: prior.id, teacherKey, expiresAt: prior.expires_at };
        throw error;
    }
    return { roomId, teacherKey, expiresAt: expires };
}
async function attempt(id: string, req: Request, teacher = false) { const a = await sql('SELECT * FROM attempts WHERE id=?', id).first<Attempt>(); if (!a)
    fail(404, 'Попытка не найдена или срок комнаты истёк.'); const r = await room(a!.room_id); await secret(req, teacher ? r.teacher_hash : a!.secret_hash, teacher ? 'x-teacher-key' : 'x-attempt-key'); return { a: a!, r }; }
async function snapshot(a: Attempt, r: Room) {
    await room(r.id);
    const ts = await roomTasks(r.id);
    const ids: string[] = JSON.parse(a.order_json);
    const base = { attemptId: a.id, roomId: r.id, title: r.title, expiresAt: r.expires_at, count: r.count, position: a.position, startedAt: a.started_at, taskStartedAt: a.task_started_at, finishedAt: a.finished_at, serverNow: Date.now(), tasks: ids.map(id => { const t = ts.find(t => t.id === id)!; return { id: t.id, ordinal: t.ordinal, photo: photo(r.id, t.id) }; }) };
    if (a.finished_at === null) {
        await room(r.id);
        return base;
    }
    const rows = (await sql('SELECT task_id,answer,correct,started_at,answered_at,duration_ms FROM answers WHERE attempt_id=? ORDER BY position', a.id).all<{
        task_id: string;
        answer: string;
        correct: number;
        started_at: number;
        answered_at: number;
        duration_ms: number;
    }>()).results;
    const report = ts.map(t => { const answer = rows.find(v => v.task_id === t.id)!; return { id: t.id, ordinal: t.ordinal, photo: photo(r.id, t.id), answer: answer.answer, correctAnswer: t.answer, correct: !!answer.correct, durationMs: answer.duration_ms, startedAt: answer.started_at, answeredAt: answer.answered_at }; });
    await room(r.id);
    return { ...base, report, summary: summarize(report, a.finished_at - a.started_at) };
}
async function start(req: Request, r: Room, ip: string) {
    const data = await body(req);
    if (!validId(data.attemptId) || !validKey(data.attemptKey))
        fail(400, 'Некорректный идентификатор попытки.');
    const old = await sql('SELECT * FROM attempts WHERE id=?', data.attemptId).first<Attempt>();
    const secretHash = await hash(data.attemptKey);
    if (old) {
        if (old.room_id !== r.id || old.secret_hash !== secretHash)
            fail(403, 'Нет доступа к попытке.');
        return snapshot(old, r);
    }
    await limit('start:' + ip, 120, 3600000);
    const tasks = await roomTasks(r.id);
    const ids = tasks.map(t => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
        const bound = Math.floor(4294967296 / (i + 1)) * (i + 1);
        let x: number;
        do {
            x = crypto.getRandomValues(new Uint32Array(1))[0];
        } while (x >= bound);
        const j = x % (i + 1);
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const now = Date.now();
    await sql('INSERT INTO attempts (id,room_id,secret_hash,order_json,position,started_at,task_started_at) SELECT ?,?,?,?,0,?,? WHERE (SELECT count(*) FROM attempts WHERE room_id=?) < 120 AND EXISTS (SELECT 1 FROM rooms WHERE id=? AND expires_at>?) ON CONFLICT(id) DO NOTHING', data.attemptId, r.id, secretHash, JSON.stringify(ids), now, now, r.id, r.id, now).run();
    const a = await sql('SELECT * FROM attempts WHERE id=?', data.attemptId).first<Attempt>();
    if (!a)
        fail(429, 'В этой комнате уже 120 попыток или срок комнаты истёк.');
    if (a!.secret_hash !== secretHash || a!.room_id !== r.id)
        fail(403, 'Нет доступа к попытке.');
    return snapshot(a!, r);
}
async function submit(req: Request, a: Attempt, r: Room) {
    const data = await body(req);
    if (!validId(data.requestId) || typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 200 || !Number.isInteger(data.position))
        fail(400, 'Введите ответ от 1 до 200 символов.');
    const prior = await sql('SELECT answer,position,task_id FROM answers WHERE attempt_id=? AND request_id=?', a.id, data.requestId).first<{
        answer: string;
        position: number;
        task_id: string;
    }>();
    if (prior) {
        if (prior.answer !== data.answer.trim() || prior.position !== data.position || prior.task_id !== data.taskId)
            fail(409, 'Этот запрос уже использован для другого ответа.');
        const fresh = await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>();
        return snapshot(fresh!, r);
    }
    const ids: string[] = JSON.parse(a.order_json);
    if (a.finished_at !== null || data.position !== a.position || data.taskId !== ids[a.position])
        fail(409, 'Эта задача уже отправлена. Обновите состояние попытки.');
    const task = await sql('SELECT answer FROM tasks WHERE id=? AND room_id=?', data.taskId, r.id).first<{
        answer: string;
    }>();
    if (!task)
        fail(400, 'Задача не принадлежит этой попытке.');
    const correct = normalizeAnswer(task!.answer) === normalizeAnswer(data.answer);
    const now = Date.now();
    await db().batch([
        sql('INSERT INTO answers (id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms) SELECT ?,id,position,?,?,?, ?,task_started_at,MAX(?,task_started_at),MAX(0,?-task_started_at) FROM attempts WHERE id=? AND position=? AND finished_at IS NULL AND EXISTS (SELECT 1 FROM rooms WHERE id=attempts.room_id AND expires_at>?) ON CONFLICT DO NOTHING', random(), data.taskId, data.requestId, data.answer.trim(), correct ? 1 : 0, now, now, a.id, data.position, now),
        sql('UPDATE attempts SET position=position+1,task_started_at=(SELECT answered_at FROM answers WHERE attempt_id=? AND request_id=?),finished_at=CASE WHEN position+1=? THEN (SELECT answered_at FROM answers WHERE attempt_id=? AND request_id=?) ELSE NULL END WHERE id=? AND position=? AND EXISTS (SELECT 1 FROM answers WHERE attempt_id=? AND request_id=? AND position=?)', a.id, data.requestId, r.count, a.id, data.requestId, a.id, data.position, a.id, data.requestId, data.position)
    ]);
    const saved = await sql('SELECT request_id,answer,task_id FROM answers WHERE attempt_id=? AND position=?', a.id, data.position).first<{
        request_id: string;
        answer: string;
        task_id: string;
    }>();
    if (!saved || saved.request_id !== data.requestId || saved.answer !== data.answer.trim() || saved.task_id !== data.taskId)
        fail(409, 'Задача уже отправлена с другим ответом. Обновите состояние попытки.');
    const updated = await sql('SELECT * FROM attempts WHERE id=?', a.id).first<Attempt>();
    await room(r.id);
    return snapshot(updated!, r);
}
export async function cleanup() { const now = Date.now(); const expired = (await sql('SELECT key FROM blobs WHERE expires_at<=? LIMIT 500', now).all<{
    key: string;
}>()).results; for (let i = 0; i < expired.length; i += 100)
    await bucket().delete(expired.slice(i, i + 100).map(o => o.key)); if (expired.length)
    await db().batch(expired.map(o => sql('DELETE FROM blobs WHERE key=? AND expires_at<=?', o.key, now))); await sql('DELETE FROM rooms WHERE expires_at<=? AND NOT EXISTS (SELECT 1 FROM tasks JOIN blobs ON blobs.key=tasks.file_key WHERE tasks.room_id=rooms.id)', now).run(); await sql('DELETE FROM rate_limits WHERE expires_at<=?', now).run(); return { ok: true, deletedFiles: expired.length }; }
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
export async function handle(req: Request) {
    const trace: RequestTrace = { id: crypto.randomUUID(), phase: 'request', started: Date.now() };
    try {
        const url = new URL(req.url);
        const p = url.pathname.split('/').filter(Boolean).slice(1);
        const method = req.method;
        if (method !== 'GET' && req.headers.get('origin') && req.headers.get('origin') !== url.origin)
            fail(403, 'Запрос с другого сайта запрещён.');
        if (req.headers.get('sec-fetch-site') === 'cross-site')
            fail(403, 'Запрос с другого сайта запрещён.');
        if (p[0] === 'health')
            return Response.json({ ok: true }, { headers });
        const ip = await hash((req.headers.get('cf-connecting-ip') || 'local') + ':' + new Date().toISOString().slice(0, 10));
        await limit('api:' + ip, 900, 60000);
        let result: unknown;
        if (p[0] === 'cleanup' && method === 'POST') {
            await limit('cleanup:global', 1, 60000);
            result = await cleanup();
        }
        else if (p[0] === 'rooms' && p.length === 1 && method === 'POST')
            result = await createRoom(req, ip, trace);
        else if (p[0] === 'creations' && p.length === 2 && method === 'GET') {
            const key = req.headers.get('x-teacher-key') || '';
            if (!validId(p[1]) || !validKey(key)) fail(404, 'Создание комнаты не найдено.');
            const saved = await sql('SELECT * FROM rooms WHERE request_id=? AND teacher_hash=?', p[1], await hash(key)).first<Room>();
            if (!saved) fail(404, 'Создание комнаты не найдено.');
            const r = await room(saved!.id);
            result = { roomId: r.id, teacherKey: key, expiresAt: r.expires_at };
        }
        else if (p[0] === 'rooms' && p[1]) {
            const r = await room(p[1]);
            if (p.length === 2 && method === 'GET')
                result = roomPublic(r, await roomTasks(r.id));
            else if (p[2] === 'start' && method === 'POST')
                result = await start(req, r, ip);
            else if (p[2] === 'teacher' && method === 'GET') {
                await secret(req, r.teacher_hash, 'x-teacher-key');
                const list = (await sql('SELECT id,started_at,finished_at,position FROM attempts WHERE room_id=? ORDER BY started_at,id', r.id).all<{
                    id: string;
                    started_at: number;
                    finished_at: number | null;
                    position: number;
                }>()).results;
                result = { ...roomPublic(r, await roomTasks(r.id)), attempts: list.map((a, i) => ({ id: a.id, number: i + 1, startedAt: a.started_at, finishedAt: a.finished_at, position: a.position })) };
            }
            else if (p[2] === 'photos' && p[3] && method === 'GET') {
                const t = await sql('SELECT * FROM tasks WHERE id=? AND room_id=?', p[3], r.id).first<Task>();
                if (!t)
                    fail(404, 'Фотография не найдена.');
                const object = await bucket().get(t!.file_key);
                if (!object)
                    fail(404, 'Фотография недоступна.');
                await room(r.id);
                return new Response(object!.body, { headers: { ...headers, 'Content-Type': t!.mime, 'Content-Disposition': 'inline' } });
            }
            else
                fail(404, 'Страница не найдена.');
        }
        else if (p[0] === 'attempts' && p[1]) {
            const { a, r } = await attempt(p[1], req, p[2] === 'report');
            if (method === 'GET')
                result = await snapshot(a, r);
            else if (p[2] === 'answers' && method === 'POST')
                result = await submit(req, a, r);
            else
                fail(404, 'Страница не найдена.');
        }
        else
            fail(404, 'Страница не найдена.');
        return Response.json(result, { headers });
    }
    catch (e) {
        if (e instanceof HttpError)
            return Response.json({ error: e.message }, { status: e.status, headers });
        console.error(JSON.stringify({ event: 'taskbattle-request-failed', traceId: trace.id, phase: trace.phase, elapsedMs: Date.now() - trace.started, errorName: e instanceof Error ? e.name : 'unknown' }));
        return Response.json({ error: 'Не удалось связаться с сервером. Введённые данные сохранены — повторите запрос.', traceId: trace.id }, { status: 503, headers });
    }
}
