import { inspectImage } from '../image-file';
import { LIMITS } from '../limits';
import {
  db,
  fail,
  hash,
  HttpError,
  limit,
  random,
  room,
  sql,
  validId,
  validKey,
  type RequestTrace,
  type Room,
  type Task,
} from './context';
import { bucket } from './storage';
export async function createRoom(req: Request, ip: string, trace: RequestTrace) {
  trace.phase = 'parse-upload';
  if (Number(req.headers.get('content-length')) > LIMITS.roomBytes + 1024 * 1024)
    fail(413, 'Не больше 18 МБ фотографий на комнату.');
  if (!req.headers.get('content-type')?.startsWith('multipart/form-data'))
    fail(415, 'Нужны фотографии JPEG, PNG или WebP.');
  let bytes = 0;
  const stream = req.body?.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > LIMITS.roomBytes + 1024 * 1024)
          throw new HttpError(413, 'Не больше 18 МБ фотографий на комнату.');
        controller.enqueue(chunk);
      },
    }),
  );
  if (!stream) fail(400, 'Добавьте фотографии.');
  const form = await new Response(stream, {
    headers: { 'content-type': req.headers.get('content-type')! },
  }).formData();
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
  if (title.length > LIMITS.titleLength) fail(400, 'Название — не больше 100 символов.');
  let correct: unknown;
  try {
    correct = JSON.parse(String(form.get('answers')));
  } catch {
    fail(400, 'Укажите ответы на все задачи.');
  }
  const files = form.getAll('photos');
  if (
    files.length < 1 ||
    files.length > LIMITS.tasks ||
    !Array.isArray(correct) ||
    correct.length !== files.length
  )
    fail(400, 'Нужно от 1 до 25 фотографий с ответами.');
  const values = correct as unknown[];
  if (values.some((a) => typeof a !== 'string' || !a.trim() || a.length > LIMITS.answerLength))
    fail(400, 'Каждой задаче нужен ответ от 1 до 200 символов.');
  let total = 0;
  for (const file of files) {
    if (!(file instanceof File) || file.size === 0 || file.size > LIMITS.fileBytes)
      fail(400, 'Выберите непустые фотографии размером до 3 МБ каждая.');
    total += (file as File).size;
  }
  if (total > LIMITS.roomBytes) fail(413, 'Не больше 18 МБ фотографий на комнату.');
  const checked: {
    file: File;
    mime: string;
  }[] = [];
  for (const file of files as File[]) {
    const mime = inspectImage(new Uint8Array(await file.arrayBuffer()))?.mime;
    if (!mime || mime !== file.type || !/\.(jpe?g|png|webp)$/i.test(file.name))
      fail(415, 'Файл не является фотографией JPEG, PNG или WebP.');
    checked.push({ file, mime: mime! });
  }
  const now = Date.now(),
    expires = now + LIMITS.roomTtlMs,
    roomId = random() + '.' + expires.toString(36);
  const keys: string[] = [];
  const taskRows: Task[] = [];
  try {
    trace.phase = 'store-photos';
    for (let i = 0; i < checked.length; i++) {
      const t = random(),
        key = `rooms/${roomId}/${t}`;
      keys.push(key);
      await sql('INSERT INTO blobs (key,expires_at) VALUES (?,?)', key, now + 3600000).run();
      await bucket().put(key, checked[i].file.stream(), {
        httpMetadata: { contentType: checked[i].mime },
      });
      taskRows.push({
        id: t,
        room_id: roomId,
        ordinal: i + 1,
        file_key: key,
        mime: checked[i].mime,
        answer: String(values[i]).trim(),
      });
    }
    trace.phase = 'commit-room';
    await db().batch([
      sql(
        'INSERT INTO rooms (id,request_id,title,teacher_hash,created_at,expires_at,count) VALUES (?,?,?,?,?,?,?)',
        roomId,
        requestId,
        title,
        teacherHash,
        now,
        expires,
        files.length,
      ),
      ...taskRows.map((t) =>
        sql(
          'INSERT INTO tasks (id,room_id,ordinal,file_key,mime,answer) VALUES (?,?,?,?,?,?)',
          t.id,
          roomId,
          t.ordinal,
          t.file_key,
          t.mime,
          t.answer,
        ),
      ),
      ...keys.map((k) => sql('UPDATE blobs SET expires_at=? WHERE key=?', expires, k)),
    ]);
  } catch (error) {
    const prior = await sql('SELECT * FROM rooms WHERE request_id=?', requestId).first<Room>();
    if (prior?.id !== roomId) {
      await bucket().delete(keys);
      for (const k of keys) await sql('DELETE FROM blobs WHERE key=?', k).run();
    }
    if (prior && prior.teacher_hash === teacherHash)
      return { roomId: prior.id, teacherKey, expiresAt: prior.expires_at };
    throw error;
  }
  return { roomId, teacherKey, expiresAt: expires };
}
