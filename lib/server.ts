import { env } from 'cloudflare:workers';
import { normalizeAnswer, summarize } from './normalization';
import {inspectImage} from './image-file';
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
    timing_version: number;
    ready_id: string | null;
    result_expires_at: number | null;
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
    constructor(public status: number, message: string, public code = 'request') { super(message); }
}
const fail = (s: number, m: string, code = 'request'): never => { throw new HttpError(s, m, code); };
const db = () => { if (!env.DB)
    fail(503, 'TaskBattle временно недоступен. Попробуйте позже.'); return env.DB!; };
const bucket = () => { if (!env.BUCKET)
    fail(503, 'Фотографии временно недоступны. Попробуйте позже.'); return env.BUCKET!; };
const sql = (query: string, ...args: (string | number | null)[]) => db().prepare(query).bind(...args);
const random = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const validKey = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(v);
const validId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{20,100}$/.test(v);
async function secret(req: Request, expected: string, header = 'x-attempt-key') { const key = req.headers.get(header) || ''; if (!validKey(key) || await hash(key) !== expected)
    fail(403, 'Нет доступа. Откройте полную секретную ссылку.'); }
async function room(id: string, allowClosed = false) { if (!validId(id))
    fail(404, 'Комната не найдена.'); const r = await sql('SELECT * FROM rooms WHERE id = ?', id).first<Room>(); if (!r) {
    const stamp = parseInt(id.split('.')[1] || '', 36);
    if (Number.isFinite(stamp) && stamp < Date.now())
        fail(410, allowClosed ? 'Срок хранения результата истёк' : 'Срок действия комнаты истёк');
    fail(404, 'Комната не найдена. Проверьте ссылку.');
} if (!allowClosed && r!.expires_at <= Date.now())
    fail(410, 'Срок действия комнаты истёк'); return r!; }
async function roomTasks(id: string) { return (await sql('SELECT * FROM tasks WHERE room_id = ? ORDER BY ordinal', id).all<Task>()).results; }
const photo = (r: string, t: string) => `/api/rooms/${r}/photos/${t}`;
const roomPublic = (r: Room, ts: Task[]) => ({ roomId: r.id, title: r.title, count: r.count, createdAt: r.created_at, expiresAt: r.expires_at, tasks: ts.map(t => ({ id: t.id, ordinal: t.ordinal, photo: photo(r.id, t.id) })), serverNow: Date.now() });
async function limit(key: string, max: number, window: number) { const now = Date.now(); const fixed = Math.floor(now / window); const result = await sql('INSERT INTO rate_limits (key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 WHERE hits < ? RETURNING hits', key + ':' + fixed, (fixed + 1) * window, max).first(); if (!result)
    fail(429, 'Слишком много запросов. Подождите немного и повторите.'); }
async function body(req: Request) { if (Number(req.headers.get('content-length')) > 8192)
    fail(413, 'Слишком большой запрос.'); const reader = req.body?.getReader(); if (!reader)
    fail(400, 'Данные не получены. Повторите действие.'); let size = 0; let value = ''; const decoder = new TextDecoder(); while (true) {
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
    fail(400, 'Не удалось прочитать отправленные данные. Повторите действие.');
} }
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
            fail(409, 'Не удалось создать комнату. Откройте главную страницу и добавьте задачи заново.');
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
    if (files.length < 1 || files.length > 25 || !Array.isArray(correct) || correct.length !== files.length)
        fail(400, 'Нужно от 1 до 25 фотографий с ответами.');
    const values = correct as unknown[];
    if (values.some(a => typeof a !== 'string' || !a.trim() || a.length > 200))
        fail(400, 'Каждой задаче нужен ответ от 1 до 200 символов.');
    let total = 0;
    for (const file of files) {
        if (!(file instanceof File) || file.size === 0 || file.size > 3 * 1024 * 1024)
            fail(400, 'Выберите непустые фотографии размером до 3 МБ каждая.');
        total += (file as File).size;
    }
    if (total > 18 * 1024 * 1024)
        fail(413, 'Не больше 18 МБ фотографий на комнату.');
    const checked: {
        file: File;
        mime: string;
    }[] = [];
    for (const file of files as File[]) {
        const mime = inspectImage(new Uint8Array(await file.arrayBuffer()))?.mime;
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
const RESULT_TTL = 72 * 3600000;
type Answer = { task_id:string; position:number; request_id:string; answer:string; correct:number; duration_ms:number; started_at:number; answered_at:number; ready_id:string|null; solution_key:string|null; solution_mime:string|null; solution_digest:string|null };
const resultExpiry = (a:Attempt) => a.result_expires_at ?? ((a.finished_at ?? 0) + RESULT_TTL);
async function assertAccessTime(a:Attempt,r:Room) {
    if (a.finished_at !== null) { if(resultExpiry(a)<=Date.now()) fail(410,'Срок хранения результата истёк'); }
    else if(r.expires_at<=Date.now()) fail(410,'Срок действия комнаты истёк');
}
async function attempt(id:string,req:Request,teacher=false) {
    if(!validId(id)) fail(404,'Попытка не найдена.');
    const a=await sql('SELECT * FROM attempts WHERE id=?',id).first<Attempt>();
    if(!a){
        const old=await sql('SELECT * FROM expired_attempts WHERE id=?',id).first<{secret_hash:string;teacher_hash:string;reason:string}>();
        if(old){await secret(req,teacher?old.teacher_hash:old.secret_hash,teacher?'x-teacher-key':'x-attempt-key');fail(410,old.reason==='result'?'Срок хранения результата истёк':'Срок действия комнаты истёк');}
        fail(404,'Попытка не найдена. Проверьте ссылку.');
    }
    const r=await room(a!.room_id,true);
    await secret(req,teacher?r.teacher_hash:a!.secret_hash,teacher?'x-teacher-key':'x-attempt-key');
    await assertAccessTime(a!,r);return {a:a!,r};
}
async function snapshot(a:Attempt,r:Room) {
    await assertAccessTime(a,r);
    const ts=await roomTasks(r.id),ids:string[]=JSON.parse(a.order_json);
    const rows=(await sql('SELECT * FROM answers WHERE attempt_id=? ORDER BY position',a.id).all<Answer>()).results;
    const completedMs=rows.reduce((sum,row)=>sum+row.duration_ms,0);
    const active=a.timing_version===1||a.ready_id!==null;
    const base={attemptId:a.id,roomId:r.id,title:r.title,roomExpiresAt:r.expires_at,expiresAt:a.finished_at!==null?resultExpiry(a):r.expires_at,resultExpiresAt:a.finished_at!==null?resultExpiry(a):null,count:r.count,position:a.position,startedAt:a.started_at,taskStartedAt:active?a.task_started_at:null,readyId:a.timing_version===1?'legacy':a.ready_id,timingVersion:a.timing_version,completedMs,finishedAt:a.finished_at,serverNow:Date.now(),tasks:ids.map(id=>{const t=ts.find(t=>t.id===id)!;return {id:t.id,ordinal:t.ordinal,photo:`/api/attempts/${a.id}/photos/${t.id}`};})};
    if(a.finished_at===null)return base;
    const report=ts.map(t=>{const answer=rows.find(v=>v.task_id===t.id)!;return {id:t.id,ordinal:t.ordinal,photo:`/api/attempts/${a.id}/photos/${t.id}`,answer:answer.answer,correctAnswer:t.answer,correct:!!answer.correct,durationMs:answer.duration_ms,startedAt:answer.started_at,answeredAt:answer.answered_at,solutionPhoto:answer.solution_key?`/api/attempts/${a.id}/solutions/${t.id}`:null};});
    return {...base,report,summary:summarize(report)};
}
async function start(req:Request,r:Room,ip:string) {
    const data=await body(req);
    if(!validId(data.attemptId)||!validKey(data.attemptKey))fail(400,'Не удалось начать попытку. Откройте ссылку на занятие и нажмите «Старт».');
    const secretHash=await hash(data.attemptKey),old=await sql('SELECT * FROM attempts WHERE id=?',data.attemptId).first<Attempt>();
    if(old){if(old.room_id!==r.id||old.secret_hash!==secretHash)fail(403,'Нет доступа к попытке.');return snapshot(old,r);}
    await limit('start:'+ip,120,3600000);
    const ids=(await roomTasks(r.id)).map(t=>t.id);
    for(let i=ids.length-1;i>0;i--){const bound=Math.floor(4294967296/(i+1))*(i+1);let x:number;do{x=crypto.getRandomValues(new Uint32Array(1))[0];}while(x>=bound);const j=x%(i+1);[ids[i],ids[j]]=[ids[j],ids[i]];}
    const now=Date.now();
    await sql('INSERT INTO attempts (id,room_id,secret_hash,order_json,position,started_at,task_started_at,timing_version) SELECT ?,?,?,?,0,?,0,2 WHERE (SELECT count(*) FROM attempts WHERE room_id=?)<120 AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND expires_at>?) ON CONFLICT(id) DO NOTHING',data.attemptId,r.id,secretHash,JSON.stringify(ids),now,r.id,r.id,now).run();
    const a=await sql('SELECT * FROM attempts WHERE id=?',data.attemptId).first<Attempt>();
    if(!a)fail(429,'В этой комнате уже 120 попыток или срок комнаты истёк.');
    if(a!.secret_hash!==secretHash||a!.room_id!==r.id)fail(403,'Нет доступа к попытке.');
    return snapshot(a!,r);
}
async function ready(req:Request,a:Attempt,r:Room) {
    const data=await body(req),ids:string[]=JSON.parse(a.order_json),now=Date.now();
    if(a.finished_at!==null||data.position!==a.position||data.taskId!==ids[a.position])fail(409,'Задача уже изменена. Проверьте отправку.');
    if(a.timing_version===1)return snapshot(a,r);
    if(!validId(data.readyId)||!Number.isSafeInteger(data.startedAt)||data.startedAt<r.created_at||data.startedAt>now+60000)fail(400,'Не удалось начать задачу. Обновите страницу.');
    await sql('UPDATE attempts SET ready_id=?,task_started_at=?,started_at=CASE WHEN position=0 THEN ? ELSE started_at END WHERE id=? AND position=? AND ready_id IS NULL AND finished_at IS NULL AND EXISTS(SELECT 1 FROM rooms WHERE id=attempts.room_id AND expires_at>?)',data.readyId,data.startedAt,data.startedAt,a.id,a.position,now).run();
    const fresh=await sql('SELECT * FROM attempts WHERE id=?',a.id).first<Attempt>();
    return snapshot(fresh!,r);
}
async function answerBody(req:Request):Promise<{data:any;file:File|null}> {
    if(!req.headers.get('content-type')?.startsWith('multipart/form-data'))return {data:await body(req),file:null};
    if(Number(req.headers.get('content-length'))>3*1024*1024+16384)fail(413,'Фото решения — до 3 МБ.');
    let bytes=0;
    const stream=req.body?.pipeThrough(new TransformStream({transform(chunk,c){bytes+=chunk.byteLength;if(bytes>3*1024*1024+16384)throw new HttpError(413,'Фото решения — до 3 МБ.');c.enqueue(chunk);}}));
    if(!stream)fail(400,'Не удалось отправить ответ. Повторите.');
    const form=await new Response(stream,{headers:{'content-type':req.headers.get('content-type')!}}).formData();
    let data:any;try{data=JSON.parse(String(form.get('payload')));}catch{fail(400,'Не удалось отправить ответ. Повторите.');}
    const file=form.get('solution');if(form.getAll('solution').length>1||file!==null&&!(file instanceof File))fail(400,'Можно прикрепить одно фото решения.');
    return {data,file:file as File|null};
}
async function cancelAnswer(req:Request,a:Attempt,r:Room){
    const data=await body(req),ids:string[]=JSON.parse(a.order_json);
    if(!validId(data.requestId)||!Number.isInteger(data.position)||ids[data.position]!==data.taskId)fail(400,'Не удалось проверить отправку. Повторите действие.');
    // This statement and submit's conditional INSERT serialize in D1. A late
    // upload cannot commit once its request was cancelled for editing.
    await sql('INSERT INTO cancelled_answers(attempt_id,request_id) SELECT id,? FROM attempts WHERE id=? AND position=? AND finished_at IS NULL AND NOT EXISTS(SELECT 1 FROM answers WHERE attempt_id=? AND request_id=?) ON CONFLICT DO NOTHING',data.requestId,a.id,data.position,a.id,data.requestId).run();
    const fresh=(await sql('SELECT * FROM attempts WHERE id=?',a.id).first<Attempt>())!;
    const cancelled=!!await sql('SELECT request_id FROM cancelled_answers WHERE attempt_id=? AND request_id=?',a.id,data.requestId).first();
    return {cancelled:cancelled&&fresh.position===data.position,snapshot:await snapshot(fresh,r)};
}
async function discardUnusedPhoto(key:string|null){
    if(!key)return;
    try{
        const claimed=await sql("UPDATE blobs SET state='deleting' WHERE key=? AND state='live' AND NOT EXISTS(SELECT 1 FROM answers WHERE solution_key=?) RETURNING key",key,key).first();
        if(claimed){await bucket().delete(key);await sql("DELETE FROM blobs WHERE key=? AND state='deleting'",key).run();}
    }catch{/* Registered orphan remains eligible for scheduled cleanup. */}
}
async function submit(req:Request,a:Attempt,r:Room,trace:RequestTrace) {
    trace.phase='validate-answer';
    const {data,file}=await answerBody(req);
    if(!validId(data.requestId)||typeof data.answer!=='string'||!data.answer.trim()||data.answer.length>200||!Number.isInteger(data.position))fail(400,'Введите ответ от 1 до 200 символов.');
    let digest:string|null=null,mime:string|null=null,bytes:Uint8Array|null=null;
    if(file){
        if(!file.size||file.size>3*1024*1024)fail(413,'Фото решения — до 3 МБ.');
        bytes=new Uint8Array(await file.arrayBuffer());mime=inspectImage(bytes)?.mime||null;
        if(!mime||mime!==file.type||!/\.(jpe?g|png|webp)$/i.test(file.name))fail(415,'Выберите JPEG, PNG или WebP. HEIC/HEIF сначала сохраните как JPEG.');
        digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.buffer as ArrayBuffer)),b=>b.toString(16).padStart(2,'0')).join('');
    }
    if(a.timing_version===2&&(!Number.isSafeInteger(data.durationMs)||data.durationMs<0||data.durationMs>48*3600000||!validId(data.readyId)))fail(400,'Не удалось отправить время. Обновите страницу.');
    const matches=(row:Answer)=>row.answer===data.answer.trim()&&row.position===data.position&&row.task_id===data.taskId&&row.solution_digest===digest&&(a.timing_version===1||row.duration_ms===data.durationMs&&row.ready_id===data.readyId);
    const prior=await sql('SELECT * FROM answers WHERE attempt_id=? AND request_id=?',a.id,data.requestId).first<Answer>();
    if(prior){if(!matches(prior))fail(409,'Уже принят другой ответ. Проверьте отправку.');return snapshot((await sql('SELECT * FROM attempts WHERE id=?',a.id).first<Attempt>())!,r);}
    if(await sql('SELECT request_id FROM cancelled_answers WHERE attempt_id=? AND request_id=?',a.id,data.requestId).first())fail(409,'Этот вариант отменён. Отправьте изменённый ответ.','cancelled');
    const ids:string[]=JSON.parse(a.order_json);
    if(a.finished_at!==null||data.position!==a.position||data.taskId!==ids[a.position]||a.timing_version===2&&(!a.ready_id||a.ready_id!==data.readyId))fail(409,'Задача уже изменена. Проверьте отправку.');
    const duration=a.timing_version===2?data.durationMs:Math.max(0,Date.now()-a.task_started_at);
    if(duration>Math.max(0,Date.now()-a.task_started_at)+60000)fail(400,'Не удалось отправить время. Обновите страницу.');
    const t=await sql('SELECT * FROM tasks WHERE id=? AND room_id=?',data.taskId,r.id).first<Task>();
    if(!t)fail(404,'Задача не найдена.');
    let solutionKey:string|null=null;
    if(file&&bytes&&mime&&digest){
        solutionKey=`solutions/${a.id}/${data.requestId}/${random()}`;
        await sql("INSERT INTO blobs(key,expires_at,state) VALUES (?,?,'live') ON CONFLICT(key) DO NOTHING",solutionKey,Date.now()+3600000).run();
        const lease=await sql("SELECT key FROM blobs WHERE key=? AND state='live'",solutionKey).first();
        if(!lease)fail(409,'Не удалось загрузить фото. Повторите отправку.');
        trace.phase='store-solution-photo';
        try{await bucket().put(solutionKey,bytes,{httpMetadata:{contentType:mime}});}
        catch(e){console.warn(JSON.stringify({event:'solution-upload-failed',phase:trace.phase,errorName:e instanceof Error?e.name:'UnknownError'}));await discardUnusedPhoto(solutionKey);fail(503,'Не удалось загрузить фото. Повторите отправку.','photo-upload');}
    }
    const now=Date.now(),end=a.task_started_at+duration;
    trace.phase='commit-answer';
    try{await db().batch([
        sql(`INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms,ready_id,received_at,solution_key,solution_mime,solution_digest)
        SELECT ?,id,position,?,?,?,?,task_started_at,?,?,?,?,?,?,? FROM attempts WHERE id=? AND position=? AND finished_at IS NULL AND (timing_version=1 OR ready_id=?) AND EXISTS(SELECT 1 FROM rooms WHERE id=attempts.room_id AND expires_at>?) AND (? IS NULL OR EXISTS(SELECT 1 FROM blobs WHERE key=? AND state='live')) AND NOT EXISTS(SELECT 1 FROM cancelled_answers WHERE attempt_id=attempts.id AND request_id=?) ON CONFLICT DO NOTHING`,random(),data.taskId,data.requestId,data.answer.trim(),normalizeAnswer(t!.answer)===normalizeAnswer(data.answer)?1:0,end,duration,a.ready_id,now,solutionKey,mime,digest,a.id,data.position,a.ready_id,now,solutionKey,solutionKey,data.requestId),
        sql(`UPDATE attempts SET position=position+1,ready_id=NULL,task_started_at=CASE WHEN timing_version=1 THEN ? ELSE 0 END,finished_at=CASE WHEN position+1=? THEN ? ELSE NULL END,result_expires_at=CASE WHEN position+1=? THEN ? ELSE NULL END WHERE id=? AND position=? AND EXISTS(SELECT 1 FROM answers WHERE attempt_id=? AND request_id=? AND position=?)`,now,r.count,now,r.count,now+RESULT_TTL,a.id,data.position,a.id,data.requestId,data.position),
        sql(`UPDATE blobs SET expires_at=MAX(expires_at,?) WHERE key=? AND state='live' AND EXISTS(SELECT 1 FROM answers WHERE attempt_id=? AND request_id=? AND solution_key=?)`,r.expires_at,solutionKey,a.id,data.requestId,solutionKey),
        sql(`UPDATE blobs SET expires_at=MAX(expires_at,?) WHERE key IN(SELECT file_key FROM tasks WHERE room_id=?) AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NOT NULL)`,now+RESULT_TTL,r.id,a.id),
        sql(`UPDATE blobs SET expires_at=MAX(expires_at,?) WHERE key IN(SELECT solution_key FROM answers WHERE attempt_id=?) AND EXISTS(SELECT 1 FROM attempts WHERE id=? AND finished_at IS NOT NULL)`,now+RESULT_TTL,a.id,a.id)
    ]);}catch(e){await discardUnusedPhoto(solutionKey);throw e;}
    const saved=await sql('SELECT * FROM answers WHERE attempt_id=? AND request_id=?',a.id,data.requestId).first<Answer>();
    if(saved?.solution_key!==solutionKey)await discardUnusedPhoto(solutionKey);
    if(!saved||!matches(saved)){await assertAccessTime(a,r);fail(409,'Ответ изменён или уже принят. Проверьте отправку.','conflict');}
    return snapshot((await sql('SELECT * FROM attempts WHERE id=?',a.id).first<Attempt>())!,r);
}
export async function cleanup() {
    const now=Date.now();
    await db().batch([
        sql(`INSERT OR IGNORE INTO expired_attempts(id,secret_hash,teacher_hash,reason) SELECT a.id,a.secret_hash,r.teacher_hash,CASE WHEN a.finished_at IS NULL THEN 'room' ELSE 'result' END FROM attempts a JOIN rooms r ON r.id=a.room_id WHERE (a.finished_at IS NOT NULL AND COALESCE(a.result_expires_at,a.finished_at+259200000)<=?) OR (a.finished_at IS NULL AND r.expires_at<=?)`,now,now),
        sql(`DELETE FROM attempts WHERE (finished_at IS NOT NULL AND COALESCE(result_expires_at,finished_at+259200000)<=?) OR (finished_at IS NULL AND room_id IN(SELECT id FROM rooms WHERE expires_at<=?))`,now,now),
        sql(`UPDATE blobs SET state='deleting' WHERE key IN(SELECT b.key FROM blobs b WHERE b.state='live' AND b.expires_at<=? AND NOT EXISTS(SELECT 1 FROM tasks t JOIN rooms r ON r.id=t.room_id WHERE t.file_key=b.key AND (r.expires_at>? OR EXISTS(SELECT 1 FROM attempts a WHERE a.room_id=r.id AND a.finished_at IS NOT NULL AND COALESCE(a.result_expires_at,a.finished_at+259200000)>?))) AND NOT EXISTS(SELECT 1 FROM answers x JOIN attempts a ON a.id=x.attempt_id JOIN rooms r ON r.id=a.room_id WHERE x.solution_key=b.key AND ((a.finished_at IS NULL AND r.expires_at>?) OR COALESCE(a.result_expires_at,a.finished_at+259200000)>?)) LIMIT 500)`,now,now,now,now,now)
    ]);
    const doomed=(await sql("SELECT key FROM blobs WHERE state='deleting' LIMIT 500").all<{key:string}>()).results;
    for(let i=0;i<doomed.length;i+=100)await bucket().delete(doomed.slice(i,i+100).map(x=>x.key));
    if(doomed.length)await db().batch(doomed.map(x=>sql("DELETE FROM blobs WHERE key=? AND state='deleting'",x.key)));
    await sql('DELETE FROM rooms WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM attempts WHERE room_id=rooms.id) AND NOT EXISTS(SELECT 1 FROM tasks JOIN blobs ON blobs.key=tasks.file_key WHERE tasks.room_id=rooms.id)',now).run();
    await sql('DELETE FROM rate_limits WHERE expires_at<=?',now).run();
    return {ok:true,deletedFiles:doomed.length};
}

const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
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
            const r = await room(p[1],p[2] === 'teacher' && method === 'GET');
            if (p.length === 2 && method === 'GET')
                result = roomPublic(r, await roomTasks(r.id));
            else if (p[2] === 'start' && method === 'POST')
                result = await start(req, r, ip);
            else if (p[2] === 'teacher' && method === 'GET') {
                await secret(req, r.teacher_hash, 'x-teacher-key');
                const list = (await sql('SELECT id,started_at,finished_at,position,COALESCE(result_expires_at,finished_at+259200000) AS result_expires_at FROM attempts WHERE room_id=? AND ((finished_at IS NULL AND ?>?) OR COALESCE(result_expires_at,finished_at+259200000)>?) ORDER BY started_at,id', r.id,r.expires_at,Date.now(),Date.now()).all<{
                    id: string;
                    started_at: number;
                    finished_at: number | null;
                    position: number;
                    result_expires_at: number|null;
                }>()).results;
                if(!list.length&&r.expires_at<=Date.now())fail(410,'Срок хранения результата истёк');
                result = { ...roomPublic(r, []),roomExpiresAt:r.expires_at,roomClosed:r.expires_at<=Date.now(),expiresAt:Math.max(r.expires_at,...list.map(a=>a.result_expires_at||0)), attempts: list.map((a, i) => ({ id: a.id, number: i + 1, startedAt: a.started_at, finishedAt: a.finished_at, position: a.position,resultExpiresAt:a.result_expires_at })) };
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
            const teacher=p[2]==='report'||req.headers.has('x-teacher-key');
            const { a, r } = await attempt(p[1], req, teacher);
            if(method==='GET'&&(p[2]==='photos'||p[2]==='solutions')&&p.length===4){
                let file:{file_key:string;mime:string}|null;
                if(p[2]==='photos')file=await sql('SELECT file_key,mime FROM tasks WHERE room_id=? AND id=?',r.id,p[3]).first();
                else file=await sql('SELECT solution_key AS file_key,solution_mime AS mime FROM answers WHERE attempt_id=? AND task_id=? AND solution_key IS NOT NULL',a.id,p[3]).first();
                if(!file)fail(404,'Фотография не найдена.');
                const object=await bucket().get(file!.file_key);if(!object)fail(404,'Фотография недоступна.');
                await assertAccessTime(a,r);
                return new Response(object!.body,{headers:{...headers,'Content-Type':file!.mime,'Content-Disposition':'inline'}});
            }
            else if (method === 'GET' && (p.length===2||p[2]==='report'&&p.length===3))
                result = await snapshot(a, r);
            else if(p[2]==='ready'&&method==='POST'&&!teacher)
                result=await ready(req,a,r);
            else if(p[2]==='cancel-answer'&&method==='POST'&&!teacher)
                result=await cancelAnswer(req,a,r);
            else if (p[2] === 'answers' && method === 'POST'&&!teacher)
                result = await submit(req, a, r,trace);
            else
                fail(404, 'Страница не найдена.');
        }
        else
            fail(404, 'Страница не найдена.');
        return Response.json(result, { headers });
    }
    catch (e) {
        if (e instanceof HttpError)
            return Response.json({ error: e.message, code:e.code }, { status: e.status, headers });
        console.error(JSON.stringify({ event: 'taskbattle-request-failed', traceId: trace.id, phase: trace.phase, elapsedMs: Date.now() - trace.started, errorName: e instanceof Error ? e.name : 'unknown' }));
        return Response.json({ error: trace.phase==='commit-answer'?'Не удалось сохранить ответ. Повторите отправку.':'Не удалось выполнить действие. Попробуйте ещё раз.',code:trace.phase==='commit-answer'?'answer-save':'request', traceId: trace.id }, { status: 503, headers });
    }
}
