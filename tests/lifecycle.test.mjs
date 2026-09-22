import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { loadModule } from './load-module.mjs';
import { duration, elapsed } from '../lib/time.ts';
const { inspectImage } = await loadModule('../lib/image-file.ts');
const initial = await readFile(
  new URL('../drizzle/0000_flaky_major_mapleleaf.sql', import.meta.url),
  'utf8',
);
const migration = await readFile(
  new URL('../drizzle/0001_adorable_dormammu.sql', import.meta.url),
  'utf8',
);
const recoveryMigration = await readFile(
  new URL('../drizzle/0002_open_gorilla_man.sql', import.meta.url),
  'utf8',
);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=',
  'base64',
);
let now = Date.now();
const realNow = Date.now;
Date.now = () => now;
const conn = new DatabaseSync(':memory:');
const completionMigration = await readFile(
  new URL('../drizzle/0003_attempt_completion.sql', import.meta.url),
  'utf8',
);
const backfillMigration = await readFile(
  new URL('../drizzle/0004_completion_backfill.sql', import.meta.url),
  'utf8',
);
conn.exec(
  'PRAGMA foreign_keys=ON;' +
    initial +
    migration +
    recoveryMigration +
    completionMigration +
    backfillMigration,
);
class Statement {
  constructor(query) {
    this.query = query;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    return conn.prepare(this.query).get(...this.args) || null;
  }
  async all() {
    return { results: conn.prepare(this.query).all(...this.args) };
  }
  async run() {
    return conn.prepare(this.query).run(...this.args);
  }
}
const objects = new Map();
let failDelete = false,
  solutionPutHook = null,
  solutionPutFailure = null,
  answerBatchFailure = null,
  finishBatchFailure = null,
  solutionPuts = 0;
globalThis.__taskbattleTestEnv = {
  DB: {
    prepare: (q) => new Statement(q),
    async batch(statements) {
      // D1 batches are atomic: do not yield between statements in this SQLite mock.
      const isFinish = statements[0]?.query.includes("finish_reason='manual'");
      const fault = isFinish
        ? finishBatchFailure
        : statements[0]?.query.includes('INSERT INTO answers(')
          ? answerBatchFailure
          : null;
      if (fault) answerBatchFailure = null;
      if (isFinish) finishBatchFailure = null;
      conn.exec('BEGIN');
      let out;
      try {
        out = [];
        for (const s of statements) {
          out.push(conn.prepare(s.query).run(...s.args));
          if (fault === 'rollback') throw Error('simulated commit failure');
        }
        conn.exec('COMMIT');
      } catch (e) {
        conn.exec('ROLLBACK');
        throw e;
      }
      if (fault === 'committed') throw Error('simulated lost commit acknowledgement');
      return out;
    },
  },
  BUCKET: {
    async put(k, v) {
      const bytes = new Uint8Array(await new Response(v).arrayBuffer());
      if (k.startsWith('solutions/')) {
        solutionPuts++;
        if (solutionPutHook) await solutionPutHook(k);
        const fault = solutionPutFailure;
        solutionPutFailure = null;
        if (fault === 'before') throw Error('simulated upload failure');
        objects.set(k, bytes);
        if (fault === 'after') throw Error('simulated lost upload acknowledgement');
      } else objects.set(k, bytes);
    },
    async get(k) {
      return objects.has(k) ? { body: objects.get(k) } : null;
    },
    async delete(keys) {
      if (failDelete) throw Error('simulated R2 outage');
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  },
};
const { handle, cleanup } = await loadModule('../lib/server.ts');
const key = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
async function call(path, { method = 'GET', secret, teacher = false, body, file } = {}) {
  let payload;
  if (file) {
    payload = new FormData();
    payload.set('payload', JSON.stringify(body));
    payload.set('solution', file, file.name);
  } else payload = body ? JSON.stringify(body) : undefined;
  const response = await handle(
    new Request('http://localhost/api' + path, {
      method,
      headers: {
        ...(secret ? { [teacher ? 'x-teacher-key' : 'x-attempt-key']: secret } : {}),
        ...(body && !file ? { 'content-type': 'application/json' } : {}),
      },
      body: payload,
    }),
  );
  const data = response.headers.get('content-type')?.startsWith('image/')
    ? await response.arrayBuffer()
    : await response.json();
  return { status: response.status, data };
}
async function create(count = 25) {
  const form = new FormData(),
    teacherKey = key();
  form.set('requestId', crypto.randomUUID());
  form.set('teacherKey', teacherKey);
  form.set('title', '25 испытаний');
  form.set('answers', JSON.stringify(Array(count).fill('5')));
  for (let i = 0; i < count; i++)
    form.append('photos', new Blob([png], { type: 'image/png' }), 'task.png');
  const r = await handle(new Request('http://localhost/api/rooms', { method: 'POST', body: form }));
  return { status: r.status, ...(await r.json()), teacherKey };
}
async function start(room) {
  const attemptId = crypto.randomUUID(),
    attemptKey = key();
  const r = await call(`/rooms/${room.roomId}/start`, {
    method: 'POST',
    body: { attemptId, attemptKey },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...r.data, key: attemptKey };
}
async function ready(a) {
  const r = await call(`/attempts/${a.attemptId}/ready`, {
    method: 'POST',
    secret: a.key,
    body: {
      position: a.position,
      taskId: a.tasks[a.position].id,
      startedAt: now,
      readyId: crypto.randomUUID(),
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...r.data, key: a.key };
}
const submit = (a, body, file) =>
  call(`/attempts/${a.attemptId}/answers`, { method: 'POST', secret: a.key, body, file });

test('tenths, minute carry, raw mean and sleep-aware monotonic interval', () => {
  for (const [ms, expected] of [
    [8400, '8,4 с'],
    [42000, '42,0 с'],
    [65700, '1 мин 05,7 с'],
    [59949, '59,9 с'],
    [59950, '1 мин 00,0 с'],
    [119999, '2 мин 00,0 с'],
  ])
    assert.equal(duration(ms), expected);
  assert.equal(elapsed({ elapsed: 150, wall: 1000, mono: 100 }, 900, 1600), 1650);
  assert.equal(elapsed({ elapsed: 150, wall: 1000, mono: 100 }, 11000, 110), 10150);
});
test('actual image headers and dimensions reject a forged MIME and oversized pixels', () => {
  assert.equal(inspectImage(png)?.mime, 'image/png');
  assert.equal(inspectImage(Buffer.from('not a png')), null);
  const forged = Buffer.from(png);
  forged.writeUInt32BE(30000, 16);
  assert.equal(inspectImage(forged), null);
  assert.equal(inspectImage(png.subarray(0, 24)), null);
});
test('additive migration keeps legacy rows and extends legacy report photos', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(initial);
  old.exec(
    "INSERT INTO rooms VALUES('room','request','Title','hash',1,100,1); INSERT INTO tasks VALUES('task','room',1,'photo','image/png','5'); INSERT INTO attempts(id,room_id,secret_hash,order_json,position,started_at,task_started_at,finished_at) VALUES('attempt','room','secret','[\"task\"]',1,1,1,90); INSERT INTO blobs VALUES('photo',100);",
  );
  old.exec(migration);
  assert.equal(old.prepare('SELECT answer FROM tasks').get().answer, '5');
  assert.equal(
    old.prepare('SELECT result_expires_at FROM attempts').get().result_expires_at,
    90 + 259200000,
  );
  assert.equal(old.prepare('SELECT expires_at FROM blobs').get().expires_at, 90 + 259200000);
  old.close();
});

test('25 tasks, independent attempts, delays, photos, retries, expiry and cleanup', async () => {
  const room = await create();
  assert.equal(room.status, 200, JSON.stringify(room));
  assert.equal((await create(26)).status, 400);
  const publicRoom = (await call('/rooms/' + room.roomId)).data;
  assert.equal(publicRoom.count, 25);
  assert.equal(JSON.stringify(publicRoom).includes('answer'), false);
  let a = await start(room),
    b = await start(room);
  const _unchanged = b;
  const order = a.tasks.map((t) => t.id);
  assert.deepEqual(
    a.tasks.map((t) => t.ordinal),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  now += 12000;
  assert.equal(
    (await call('/attempts/' + a.attemptId, { secret: a.key })).data.taskStartedAt,
    null,
  );
  assert.equal(a.completedMs, 0);
  let total = 0,
    _firstPayload,
    _firstPhoto,
    _firstTask;
  for (let i = 0; i < 25; i++) {
    a = await ready(a);
    const start = a.taskStartedAt;
    const alternate = await call(`/attempts/${a.attemptId}/ready`, {
      method: 'POST',
      secret: a.key,
      body: {
        position: i,
        taskId: a.tasks[i].id,
        startedAt: now + 1,
        readyId: crypto.randomUUID(),
      },
    });
    assert.equal(alternate.data.readyId, a.readyId);
    now += i === 0 ? 8432 : 1234;
    const ms = i === 0 ? 8432 : 1234;
    total += ms;
    const payload = {
      requestId: crypto.randomUUID(),
      taskId: a.tasks[i].id,
      position: i,
      answer: i === 1 ? '999' : '5,00',
      readyId: a.readyId,
      durationMs: ms,
    };
    const image = i === 0 ? new File([png], 'solution.png', { type: 'image/png' }) : undefined;
    if (i === 0) {
      assert.equal((await submit(a, { ...payload, answer: ' ' })).status, 400);
      assert.equal(
        (await submit(a, payload, new File(['HEIC'], 'image.heic', { type: 'image/heic' }))).status,
        415,
      );
      _firstPayload = payload;
      _firstPhoto = image;
      _firstTask = a.tasks[i].id;
    }
    now += 9000; // delayed upload / last submission: captured interval is unchanged
    const r = await submit(a, payload, image);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const again = await submit(a, payload, image);
    assert.equal(again.status, 200);
    assert.equal(again.data.position, i + 1);
    if (i === 0) {
      assert.equal((await submit(a, { ...payload, durationMs: ms + 1 }, image)).status, 409);
      assert.equal((await submit(a, payload)).status, 409);
    }
    a = { ...r.data, key: a.key };
    assert.equal(a.completedMs, total);
    assert.deepEqual(
      a.tasks.map((t) => t.id),
      order,
    );
    if (i < 24) {
      assert.equal(a.taskStartedAt, null);
      assert.equal(JSON.stringify(a).includes('correctAnswer'), false);
      assert.equal(JSON.stringify(a).includes('solutionPhoto'), false);
      now += 17000;
      assert.equal(
        (await call('/attempts/' + a.attemptId, { secret: a.key })).data.completedMs,
        total,
      );
    }
    const row = conn
      .prepare(
        'SELECT started_at,answered_at,duration_ms FROM answers WHERE attempt_id=? AND position=?',
      )
      .get(a.attemptId, i);
    assert.equal(row.started_at, start);
    assert.equal(row.answered_at - start, ms);
  }
  assert.equal(a.summary.totalMs, total);
  assert.equal(a.summary.averageMs, total / 25);
  assert.equal(a.summary.correct, 24);
  assert.equal(a.resultExpiresAt - a.finishedAt, 259200000);
  assert.equal(a.summary.fastest.ordinals.length, 24);
  const solution = a.report.find((t) => t.solutionPhoto).solutionPhoto;
  assert.equal((await call(solution.slice(4), { secret: a.key })).status, 200);
  assert.equal(
    (await call(solution.slice(4), { secret: room.teacherKey, teacher: true })).status,
    200,
  );
  assert.equal((await call(solution.slice(4), { secret: b.key })).status, 403);
  assert.equal((await call(solution.slice(4))).status, 403);
  assert.equal((await call('/attempts/' + b.attemptId, { secret: b.key })).data.position, 0);
  assert.equal(
    (await call('/attempts/' + a.attemptId + '/report', { secret: room.teacherKey, teacher: true }))
      .data.summary.totalMs,
    total,
  );
  // A second, later result shares task files. Legacy worker finish after migration has NULL expiry.
  now = a.finishedAt + 3600000;
  conn
    .prepare('UPDATE attempts SET finished_at=?,result_expires_at=NULL,position=25 WHERE id=?')
    .run(now, b.attemptId);
  const bExpiry = now + 259200000;
  // Model an attempt started near the end of a room's 14-day life.
  room.expiresAt = a.finishedAt + 7200000;
  conn.prepare('UPDATE rooms SET expires_at=? WHERE id=?').run(room.expiresAt, room.roomId);
  now = room.expiresAt + 1;
  assert.equal((await call('/rooms/' + room.roomId)).status, 410);
  assert.equal((await call('/attempts/' + a.attemptId, { secret: a.key })).status, 200);
  assert.equal(
    (await call('/rooms/' + room.roomId + '/teacher', { secret: room.teacherKey, teacher: true }))
      .data.attempts.length,
    2,
  );
  // Force stale journal dates to prove references, not the journal, protect files.
  conn.exec('UPDATE blobs SET expires_at=1');
  await cleanup();
  assert.equal(objects.size, 26);
  assert.equal((await call(solution.slice(4), { secret: a.key })).status, 200);
  now = a.resultExpiresAt - 1;
  assert.equal((await call('/attempts/' + a.attemptId, { secret: a.key })).status, 200);
  now = a.resultExpiresAt;
  assert.equal((await call('/attempts/' + a.attemptId, { secret: a.key })).status, 410);
  await cleanup();
  assert.equal(objects.size, 25);
  assert.equal(
    (await call('/attempts/' + a.attemptId, { secret: a.key })).data.error,
    'Срок хранения результата истёк',
  );
  assert.equal(
    (await call('/attempts/' + a.attemptId + '/report', { secret: room.teacherKey, teacher: true }))
      .data.error,
    'Срок хранения результата истёк',
  );
  assert.equal(
    (await call('/attempts/' + b.attemptId + '/photos/' + b.tasks[0].id, { secret: b.key })).status,
    200,
  );
  now = bExpiry;
  failDelete = true;
  await assert.rejects(cleanup());
  assert.equal(objects.size, 25);
  failDelete = false;
  await cleanup();
  assert.equal(objects.size, 0);
  assert.equal(conn.prepare('SELECT count(*) AS n FROM rooms').get().n, 0);
  assert.equal(
    (await call('/attempts/' + b.attemptId, { secret: b.key })).data.error,
    'Срок хранения результата истёк',
  );
  Date.now = realNow;
});

async function recoveryFixture(t) {
  now = Math.max(now, realNow()) + 3600001;
  Date.now = () => now;
  solutionPutHook = null;
  solutionPutFailure = null;
  answerBatchFailure = null;
  finishBatchFailure = null;
  failDelete = false;
  t.after(() => {
    Date.now = realNow;
    solutionPutHook = null;
    solutionPutFailure = null;
    answerBatchFailure = null;
    finishBatchFailure = null;
    failDelete = false;
  });
  const room = await create(1);
  assert.equal(room.status, 200, JSON.stringify(room));
  const a = await ready(await start(room));
  now += 5000;
  const payload = {
    requestId: crypto.randomUUID(),
    taskId: a.tasks[0].id,
    position: 0,
    answer: '5',
    readyId: a.readyId,
    durationMs: 5000,
  };
  const file = new File([png], 'solution.png', { type: 'image/png' });
  return { a, payload, file };
}
const cancel = (a, payload) =>
  call(`/attempts/${a.attemptId}/cancel-answer`, {
    method: 'POST',
    secret: a.key,
    body: { requestId: payload.requestId, position: payload.position, taskId: payload.taskId },
  });
const answerRows = (a) => conn.prepare('SELECT * FROM answers WHERE attempt_id=?').all(a.attemptId);
const solutionKeys = (a) =>
  [...objects.keys()].filter((k) => k.startsWith(`solutions/${a.attemptId}/`));
const solutionJournal = (a) =>
  conn.prepare('SELECT * FROM blobs WHERE key LIKE ?').all(`solutions/${a.attemptId}/%`);
const finish = (
  a,
  data = { requestId: crypto.randomUUID(), position: a.position, durationMs: 0 },
) => call(`/attempts/${a.attemptId}/finish`, { method: 'POST', secret: a.key, body: data });
function uploadGate(required = 1) {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let hits = 0;
  solutionPutHook = async () => {
    if (++hits === required) entered.resolve();
    await release.promise;
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

test('cancelled answer cannot upload or commit; an edited answer has a new request id', async (t) => {
  const { a, payload, file } = await recoveryFixture(t),
    puts = solutionPuts;
  const cancelled = await cancel(a, payload);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.cancelled, true);
  assert.equal(cancelled.data.snapshot.position, 0);
  const stale = await submit(a, payload, file);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'cancelled');
  assert.equal(solutionPuts, puts);
  assert.equal(answerRows(a).length, 0);
  const fresh = await submit(
    a,
    { ...payload, requestId: crypto.randomUUID(), answer: '6', durationMs: 6000 },
    file,
  );
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.summary.correct, 0);
  assert.equal(fresh.data.summary.totalMs, 6000);
  assert.equal(solutionKeys(a).length, 1);
});

test(
  'cancellation during an upload fences the late commit and removes its orphan photo',
  { timeout: 5000 },
  async (t) => {
    const { a, payload, file } = await recoveryFixture(t),
      gate = uploadGate();
    const uploading = submit(a, payload, file);
    try {
      await gate.entered;
      const cancelled = await cancel(a, payload);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.data.cancelled, true);
    } finally {
      gate.release();
    }
    const late = await uploading;
    assert.equal(late.status, 409);
    assert.equal(answerRows(a).length, 0);
    assert.equal(solutionKeys(a).length, 0);
    assert.equal(solutionJournal(a).length, 0);
    assert.equal((await call('/attempts/' + a.attemptId, { secret: a.key })).data.position, 0);
    solutionPutHook = null;
    const retry = await submit(a, { ...payload, requestId: crypto.randomUUID() }, file);
    assert.equal(retry.status, 200);
    assert.equal(answerRows(a).length, 1);
    assert.equal(solutionKeys(a).length, 1);
  },
);

test('cancellation after commit returns the accepted result and cannot reopen it', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  const accepted = await submit(a, payload, file);
  assert.equal(accepted.status, 200);
  const cancelled = await cancel(a, payload);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.cancelled, false);
  assert.equal(cancelled.data.snapshot.position, 1);
  assert.equal(cancelled.data.snapshot.report[0].answer, '5');
  assert.equal(
    conn.prepare('SELECT count(*) AS n FROM cancelled_answers WHERE attempt_id=?').get(a.attemptId)
      .n,
    0,
  );
  const editing = await submit(
    a,
    { ...payload, requestId: crypto.randomUUID(), answer: '6' },
    file,
  );
  assert.equal(editing.status, 409);
  assert.equal(answerRows(a).length, 1);
  assert.equal(solutionKeys(a).length, 1);
});

test(
  'simultaneous identical photo submissions create one answer and retain one photo',
  { timeout: 5000 },
  async (t) => {
    const { a, payload, file } = await recoveryFixture(t),
      gate = uploadGate(2);
    const first = submit(a, payload, file),
      second = submit(a, payload, file);
    try {
      await gate.entered;
    } finally {
      gate.release();
    }
    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.position, 1);
      assert.equal(response.data.summary.totalMs, 5000);
    }
    assert.equal(answerRows(a).length, 1);
    assert.equal(solutionKeys(a).length, 1);
    assert.equal(solutionJournal(a).length, 1);
    assert.equal(solutionKeys(a)[0], answerRows(a)[0].solution_key);
  },
);

test('failed photo upload removes a partially stored object and permits the same safe retry', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  solutionPutFailure = 'after';
  const failed = await submit(a, payload, file);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.code, 'photo-upload');
  assert.equal(answerRows(a).length, 0);
  assert.equal(solutionKeys(a).length, 0);
  assert.equal(solutionJournal(a).length, 0);
  const retried = await submit(a, payload, file);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.summary.totalMs, 5000);
  assert.equal(solutionKeys(a).length, 1);
});

test('rolled back answer commit removes the upload and permits a retry without duplicates', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  answerBatchFailure = 'rollback';
  const failed = await submit(a, payload, file);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.code, 'answer-save');
  assert.equal(answerRows(a).length, 0);
  assert.equal(solutionKeys(a).length, 0);
  assert.equal(solutionJournal(a).length, 0);
  assert.equal((await call('/attempts/' + a.attemptId, { secret: a.key })).data.position, 0);
  const retried = await submit(a, payload, file);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.summary.totalMs, 5000);
  assert.equal(answerRows(a).length, 1);
  assert.equal(solutionKeys(a).length, 1);
});

test('lost database commit acknowledgement preserves the accepted photo and retry returns the saved result', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  answerBatchFailure = 'committed';
  const uncertain = await submit(a, payload, file);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.data.code, 'answer-save');
  assert.equal(answerRows(a).length, 1);
  assert.equal(solutionKeys(a).length, 1);
  assert.equal(solutionKeys(a)[0], answerRows(a)[0].solution_key);
  const puts = solutionPuts;
  const retried = await submit(a, payload, file);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.summary.totalMs, 5000);
  assert.equal(solutionPuts, puts);
  const cancelled = await cancel(a, payload);
  assert.equal(cancelled.data.cancelled, false);
  assert.equal(cancelled.data.snapshot.finishedAt, retried.data.finishedAt);
  assert.equal(
    (await call(retried.data.report[0].solutionPhoto.slice(4), { secret: a.key })).status,
    200,
  );
});

test('failed immediate orphan deletion leaves a journal entry for scheduled cleanup', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  solutionPutFailure = 'after';
  failDelete = true;
  const failed = await submit(a, payload, file);
  assert.equal(failed.status, 503);
  assert.equal(answerRows(a).length, 0);
  assert.equal(solutionKeys(a).length, 1);
  assert.equal(solutionJournal(a)[0].state, 'deleting');
  failDelete = false;
  await cleanup();
  assert.equal(solutionKeys(a).length, 0);
  assert.equal(solutionJournal(a).length, 0);
  const retried = await submit(a, payload, file);
  assert.equal(retried.status, 200);
  assert.equal(solutionKeys(a).length, 1);
});

test('legacy attempt order stays immutable while new attempts use teacher ordinals', async (t) => {
  now = Math.max(now, realNow()) + 3600001;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  const room = await create(3);
  assert.equal(room.status, 200);
  const a = await start(room),
    ids = a.tasks.map((t) => t.id),
    legacy = [ids[2], ids[0], ids[1]];
  conn
    .prepare('UPDATE attempts SET order_json=? WHERE id=?')
    .run(JSON.stringify(legacy), a.attemptId);
  const loaded = (await call('/attempts/' + a.attemptId, { secret: a.key })).data;
  assert.deepEqual(
    loaded.tasks.map((t) => t.id),
    legacy,
  );
  const repeated = await call('/rooms/' + room.roomId + '/start', {
    method: 'POST',
    body: { attemptId: a.attemptId, attemptKey: a.key },
  });
  assert.deepEqual(
    repeated.data.tasks.map((t) => t.id),
    legacy,
  );
  const fresh = await start(room);
  assert.deepEqual(
    fresh.tasks.map((t) => t.ordinal),
    [1, 2, 3],
  );
  const active = await ready({ ...loaded, key: a.key });
  const accepted = await submit(active, {
    requestId: crypto.randomUUID(),
    taskId: legacy[0],
    position: 0,
    answer: '5',
    readyId: active.readyId,
    durationMs: 1,
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(
    accepted.data.tasks.map((t) => t.id),
    legacy,
  );
  assert.equal(answerRows(active)[0].task_id, legacy[0]);
});

async function partialFixture(t, count = 3) {
  await recoveryFixture(t);
  const room = await create(count);
  const a = await ready(await start(room));
  return { room, a };
}
test('manual zero-answer result, immutable double finish and no invented intervals', async (t) => {
  const { a } = await partialFixture(t);
  now += 3456;
  const intent = { requestId: crypto.randomUUID(), position: 0, durationMs: 3456 };
  const [one, two] = await Promise.all([finish(a, intent), finish(a, intent)]);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(two.data.finishedAt, one.data.finishedAt);
  assert.equal(one.data.summary.totalMs, 3456);
  assert.equal(one.data.summary.averageMs, null);
  assert.equal(one.data.summary.fastest, null);
  assert.equal(one.data.summary.slowest, null);
  assert.equal(one.data.summary.unsolved, 3);
  assert.equal(one.data.summary.wrong, 0);
  assert.equal(one.data.finishReason, 'manual');
  assert.ok(
    one.data.report.every(
      (r) => r.answer === null && r.correct === null && r.correctAnswer === '5',
    ),
  );
  now += 90000;
  const retry = await finish(a, intent);
  assert.equal(retry.data.finishedAt, one.data.finishedAt);
  assert.equal(retry.data.resultExpiresAt, one.data.resultExpiresAt);
  assert.equal(retry.data.summary.totalMs, 3456);
  assert.equal(answerRows(a).length, 0);
});
test('partial report preserves accepted photo, wrong/unsolved distinction, ties and teacher report', async (t) => {
  const { room, a: first } = await partialFixture(t, 4);
  let a = first;
  for (let i = 0; i < 2; i++) {
    now += 5000;
    const payload = {
      requestId: crypto.randomUUID(),
      position: a.position,
      taskId: a.tasks[a.position].id,
      answer: i ? '99' : '5',
      durationMs: 5000,
      readyId: a.readyId,
    };
    const out = await submit(
      a,
      payload,
      i ? undefined : new File([png], 'solution.png', { type: 'image/png' }),
    );
    assert.equal(out.status, 200, JSON.stringify(out.data));
    a = await ready({ ...out.data, key: a.key });
  }
  now += 1234;
  const out = await finish(a, { requestId: crypto.randomUUID(), position: 2, durationMs: 1234 });
  const s = out.data.summary;
  assert.equal(s.totalMs, 11234);
  assert.equal(s.averageMs, 5000);
  assert.equal(s.correct, 1);
  assert.equal(s.wrong, 1);
  assert.equal(s.unsolved, 2);
  assert.equal(s.submitted, 2);
  assert.deepEqual(s.fastest.ordinals, [1, 2]);
  assert.deepEqual(s.slowest.ordinals, [1, 2]);
  assert.equal(solutionKeys(a).length, 1);
  assert.equal(
    (
      await call(out.data.report[0].solutionPhoto.slice(4), {
        secret: room.teacherKey,
        teacher: true,
      })
    ).status,
    200,
  );
  const teacher = await call('/attempts/' + a.attemptId + '/report', {
    secret: room.teacherKey,
    teacher: true,
  });
  assert.equal(teacher.data.finishReason, 'manual');
  assert.deepEqual(teacher.data.summary, s);
});
test('finish wins during R2 upload: late attachment is removed, answer never added', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  const gate = uploadGate();
  const sending = submit(a, payload, file);
  await gate.entered;
  const out = await finish(a, { requestId: crypto.randomUUID(), position: 0, durationMs: 5000 });
  // Cleanup deleted the bytes but has not removed the journal yet when PUT finishes.
  conn
    .prepare("UPDATE blobs SET state='deleting' WHERE key LIKE ?")
    .run(`solutions/${a.attemptId}/%`);
  gate.release();
  const late = await sending;
  assert.equal(out.data.finishReason, 'manual');
  assert.equal(late.data.finishReason, 'manual');
  assert.equal(answerRows(a).length, 0);
  assert.equal(solutionKeys(a).length, 0);
  assert.equal(solutionJournal(a).length, 0);
});
test('answer wins then finish from old position: accepted time counted exactly once', async (t) => {
  const { a } = await partialFixture(t);
  now += 5000;
  const payload = {
    requestId: crypto.randomUUID(),
    position: 0,
    taskId: a.tasks[0].id,
    answer: '5',
    durationMs: 5000,
    readyId: a.readyId,
  };
  const saved = await submit(a, payload, new File([png], 'solution.png', { type: 'image/png' }));
  assert.equal(saved.data.position, 1);
  const out = await finish(a, { requestId: crypto.randomUUID(), position: 0, durationMs: 5000 });
  assert.equal(out.data.summary.totalMs, 5000);
  assert.equal(out.data.unfinishedMs, 0);
  assert.equal(out.data.summary.submitted, 1);
  assert.equal(solutionKeys(a).length, 1);
});
test('last answer terminal result cannot be overwritten by manual finish', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  const saved = await submit(a, payload, file);
  const out = await finish(a, { requestId: crypto.randomUUID(), position: 0, durationMs: 9000 });
  assert.equal(out.data.finishReason, 'completed');
  assert.equal(out.data.finishedAt, saved.data.finishedAt);
  assert.equal(out.data.summary.totalMs, 5000);
});
test('calendar deadline immutable across ready, late answer refused, timeout keeps exact deadline and 72h', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  const deadline = a.startedAt + 86400000;
  assert.equal(a.deadlineAt, deadline);
  const savedStart = conn
    .prepare('SELECT started_at FROM attempts WHERE id=?')
    .get(a.attemptId).started_at;
  assert.equal(savedStart, a.startedAt);
  now = deadline + 7200000;
  const late = await submit(a, payload, file);
  assert.equal(late.status, 409);
  assert.equal(answerRows(a).length, 0);
  assert.equal(solutionKeys(a).length, 0);
  const out = await call('/attempts/' + a.attemptId, { secret: a.key });
  assert.equal(out.data.finishedAt, deadline);
  assert.equal(out.data.resultExpiresAt, deadline + 259200000);
  assert.equal(out.data.finishReason, 'timeout');
  assert.equal(out.data.timingIncomplete, true);
  assert.equal(out.data.summary.totalMs, 0);
  const manual = await finish(a);
  assert.equal(manual.data.finishReason, 'timeout');
  now = deadline + 259200000;
  assert.equal((await call('/attempts/' + a.attemptId, { secret: a.key })).status, 410);
});
test('14-day room closes to new starts while existing attempt/photos continue; result has own 72h', async (t) => {
  const { room } = await partialFixture(t);
  const r = (await call('/rooms/' + room.roomId)).data;
  assert.equal(r.expiresAt - r.createdAt, 1209600000);
  now = r.expiresAt - 1000;
  let a = await ready(await start(room));
  now += 2000;
  assert.equal((await call('/rooms/' + room.roomId)).status, 410);
  const denied = await call('/rooms/' + room.roomId + '/start', {
    method: 'POST',
    body: { attemptId: crypto.randomUUID(), attemptKey: key() },
  });
  assert.equal(denied.status, 410);
  assert.equal((await call(a.tasks[0].photo.slice(4), { secret: a.key })).status, 200);
  const payload = {
    requestId: crypto.randomUUID(),
    position: 0,
    taskId: a.tasks[0].id,
    answer: '5',
    durationMs: 2000,
    readyId: a.readyId,
  };
  const out = await submit(a, payload, new File([png], 'solution.png', { type: 'image/png' }));
  assert.equal(out.status, 200);
  a = { ...out.data, key: a.key };
  const report = await finish(a);
  assert.equal(report.data.resultExpiresAt, now + 259200000);
  await cleanup();
  assert.equal(
    (await call(report.data.report[0].solutionPhoto.slice(4), { secret: a.key })).status,
    200,
  );
  now = report.data.resultExpiresAt;
  await cleanup();
  assert.equal(solutionKeys(a).length, 0);
});
test('closed-tab scheduled completion is bounded; backlog keeps shared photos; delayed job uses deadline', async (t) => {
  const { room, a } = await partialFixture(t);
  const row = conn.prepare('SELECT * FROM attempts WHERE id=?').get(a.attemptId);
  // Isolate a 501-row queue without involving rate-limit bypass in the API.
  conn
    .prepare(
      'UPDATE attempts SET finished_at=?,result_expires_at=? WHERE id<>? AND finished_at IS NULL',
    )
    .run(now, now + 259200000, a.attemptId);
  for (let i = 0; i < 500; i++)
    conn
      .prepare(
        'INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,deadline_at,timing_version) VALUES(?,?,?,?,?,?,?,2)',
      )
      .run(
        crypto.randomUUID(),
        room.roomId,
        row.secret_hash,
        row.order_json,
        row.started_at,
        0,
        row.deadline_at,
      );
  now = row.deadline_at + 10000;
  conn.prepare('UPDATE rooms SET expires_at=1 WHERE id=?').run(room.roomId);
  conn
    .prepare(
      'UPDATE blobs SET expires_at=1 WHERE key IN(SELECT file_key FROM tasks WHERE room_id=?)',
    )
    .run(room.roomId);
  const out = await cleanup();
  assert.equal(out.finalized, 500);
  assert.equal(
    conn
      .prepare('SELECT count(*) n FROM attempts WHERE room_id=? AND finished_at IS NULL')
      .get(room.roomId).n,
    1,
  );
  for (const t of conn.prepare('SELECT file_key FROM tasks WHERE room_id=?').all(room.roomId))
    assert.ok(objects.has(t.file_key));
  await cleanup();
  const final = conn.prepare('SELECT * FROM attempts WHERE id=?').get(a.attemptId);
  assert.equal(final.finished_at, row.deadline_at);
  assert.equal(final.result_expires_at, row.deadline_at + 259200000);
});
test('data backfill extends live rooms only and preserves answers/files and completed expiry', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(initial + migration + recoveryMigration + completionMigration);
  const time = realNow();
  for (const [id, expiry] of [
    ['live', time + 3600000],
    ['expired', time - 60000],
  ])
    old
      .prepare('INSERT INTO rooms VALUES(?,?,?,?,?,?,?)')
      .run(id, id, 'title', 'hash', time - 1000, expiry, 1);
  old.exec(
    "INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,finished_at,result_expires_at) VALUES('a','live','hash','[]',1234,1234,5678,259205678)",
  );
  old.exec(backfillMigration);
  assert.equal(
    old.prepare("SELECT expires_at FROM rooms WHERE id='live'").get().expires_at,
    time - 1000 + 1209600000,
  );
  assert.equal(
    old.prepare("SELECT expires_at FROM rooms WHERE id='expired'").get().expires_at,
    time - 60000,
  );
  assert.equal(old.prepare('SELECT deadline_at FROM attempts').get().deadline_at, 1234 + 86400000);
  assert.equal(
    old.prepare('SELECT result_expires_at FROM attempts').get().result_expires_at,
    259205678,
  );
  old.close();
});
test('manual commit rollback and lost acknowledgement both recover idempotently', async (t) => {
  const { a } = await partialFixture(t);
  now += 2000;
  const intent = { requestId: crypto.randomUUID(), position: 0, durationMs: 2000 };
  finishBatchFailure = 'rollback';
  assert.equal((await finish(a, intent)).status, 503);
  assert.equal(
    conn.prepare('SELECT finished_at FROM attempts WHERE id=?').get(a.attemptId).finished_at,
    null,
  );
  finishBatchFailure = 'committed';
  assert.equal((await finish(a, intent)).status, 503);
  const committed = conn.prepare('SELECT * FROM attempts WHERE id=?').get(a.attemptId);
  now += 60000;
  const retry = await finish(a, intent);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.finishedAt, committed.finished_at);
  assert.equal(retry.data.resultExpiresAt, committed.result_expires_at);
  assert.equal(retry.data.summary.totalMs, 2000);
});
test('photo upload crossing deadline cannot attach to timeout report or leak an orphan', async (t) => {
  const { a, payload, file } = await recoveryFixture(t);
  const gate = uploadGate(),
    sending = submit(a, payload, file);
  await gate.entered;
  now = a.deadlineAt + 1;
  gate.release();
  const out = await sending;
  assert.equal(out.data.finishReason, 'timeout');
  assert.equal(out.data.finishedAt, a.deadlineAt);
  assert.equal(answerRows(a).length, 0);
  assert.equal(solutionKeys(a).length, 0);
});
test('legacy row inserted during rollout receives a deadline on access and scheduled processing', async (t) => {
  const { a } = await partialFixture(t);
  conn.prepare('UPDATE attempts SET deadline_at=NULL WHERE id=?').run(a.attemptId);
  const accessed = await call('/attempts/' + a.attemptId, { secret: a.key });
  assert.equal(accessed.data.deadlineAt, a.startedAt + 86400000);
  conn.prepare('UPDATE attempts SET deadline_at=NULL WHERE id=?').run(a.attemptId);
  now = a.startedAt + 86400000 + 1;
  await cleanup();
  const row = conn.prepare('SELECT * FROM attempts WHERE id=?').get(a.attemptId);
  assert.equal(row.finished_at, a.startedAt + 86400000);
  assert.equal(row.finish_reason, 'timeout');
});
