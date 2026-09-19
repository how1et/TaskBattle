import { env } from 'cloudflare:workers';
export type Room = {
  id: string;
  title: string;
  teacher_hash: string;
  created_at: number;
  expires_at: number;
  count: number;
};
export type Attempt = {
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
export type Task = {
  id: string;
  room_id: string;
  ordinal: number;
  file_key: string;
  mime: string;
  answer: string;
};
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'request',
  ) {
    super(message);
  }
}
export const fail = (s: number, m: string, code = 'request'): never => {
  throw new HttpError(s, m, code);
};
export const db = () => {
  if (!env.DB) fail(503, 'TaskBattle временно недоступен. Попробуйте позже.');
  return env.DB!;
};
export const sql = (query: string, ...args: (string | number | null)[]) =>
  db()
    .prepare(query)
    .bind(...args);
export const random = (n = 24) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
export const hash = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export const validKey = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(v);
export const validId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{20,100}$/.test(v);
export async function secret(req: Request, expected: string, header = 'x-attempt-key') {
  const key = req.headers.get(header) || '';
  if (!validKey(key) || (await hash(key)) !== expected)
    fail(403, 'Нет доступа. Откройте полную секретную ссылку.');
}
export async function room(id: string, allowClosed = false) {
  if (!validId(id)) fail(404, 'Комната не найдена.');
  const r = await sql('SELECT * FROM rooms WHERE id = ?', id).first<Room>();
  if (!r) {
    const stamp = parseInt(id.split('.')[1] || '', 36);
    if (Number.isFinite(stamp) && stamp < Date.now())
      fail(410, allowClosed ? 'Срок хранения результата истёк' : 'Срок действия комнаты истёк');
    fail(404, 'Комната не найдена. Проверьте ссылку.');
  }
  if (!allowClosed && r!.expires_at <= Date.now()) fail(410, 'Срок действия комнаты истёк');
  return r!;
}
export async function roomTasks(id: string) {
  return (await sql('SELECT * FROM tasks WHERE room_id = ? ORDER BY ordinal, id', id).all<Task>())
    .results;
}
export const photo = (r: string, t: string) => `/api/rooms/${r}/photos/${t}`;
export const roomPublic = (r: Room, ts: Task[]) => ({
  roomId: r.id,
  title: r.title,
  count: r.count,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  tasks: ts.map((t) => ({ id: t.id, ordinal: t.ordinal, photo: photo(r.id, t.id) })),
  serverNow: Date.now(),
});
export async function limit(key: string, max: number, window: number) {
  const now = Date.now();
  const fixed = Math.floor(now / window);
  const result = await sql(
    'INSERT INTO rate_limits (key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 WHERE hits < ? RETURNING hits',
    key + ':' + fixed,
    (fixed + 1) * window,
    max,
  ).first();
  if (!result) fail(429, 'Слишком много запросов. Подождите немного и повторите.');
}
export async function body(req: Request) {
  if (Number(req.headers.get('content-length')) > 8192) fail(413, 'Слишком большой запрос.');
  const reader = req.body?.getReader();
  if (!reader) fail(400, 'Данные не получены. Повторите действие.');
  let size = 0;
  let value = '';
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader!.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 8192) {
      await reader!.cancel();
      fail(413, 'Слишком большой запрос.');
    }
    value += decoder.decode(chunk.value, { stream: true });
  }
  try {
    const data = JSON.parse(value + decoder.decode());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid object');
    return data;
  } catch {
    fail(400, 'Не удалось прочитать отправленные данные. Повторите действие.');
  }
}
export type RequestTrace = { id: string; phase: string; started: number };
