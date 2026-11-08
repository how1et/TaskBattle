import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadModule } from './load-module.mjs';

const DAY = 86_400_000;
const OLD_TTL = 3 * DAY;
const NEW_TTL = 28 * DAY;
const CUTOFF = Date.UTC(2026, 10, 8, 12);
const realNow = Date.now;
let now = CUTOFF;
Date.now = () => now;
const migrations = await Promise.all(
  [
    '0000_flaky_major_mapleleaf',
    '0001_adorable_dormammu',
    '0002_open_gorilla_man',
    '0003_attempt_completion',
    '0004_completion_backfill',
    '0005_navigation_and_exports',
    '0009_result_retention',
  ].map((name) => readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8')),
);
let connection;
const photos = new Map();
const removed = [];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=',
  'base64',
);
class Statement {
  constructor(query, args = []) {
    this.query = query;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.query, args);
  }
  async first() {
    return connection.prepare(this.query).get(...this.args) || null;
  }
  async all() {
    return { results: connection.prepare(this.query).all(...this.args) };
  }
  async run() {
    const result = connection.prepare(this.query).run(...this.args);
    return { ...result, meta: { changes: Number(result.changes) } };
  }
}
globalThis.__taskbattleTestEnv = {
  DB: {
    prepare: (query) => new Statement(query),
    async batch(statements) {
      connection.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        connection.exec('COMMIT');
        return result;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
  },
  BUCKET: {
    async get(key) {
      return photos.has(key) ? { body: photos.get(key) } : null;
    },
    async put(key, data) {
      photos.set(key, new Uint8Array(await new Response(data).arrayBuffer()));
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        removed.push(key);
        photos.delete(key);
      }
    },
  },
};
const { handle, cleanup } = await loadModule('../lib/server.ts');
const { ensureRetentionPolicy, migrateRetentionBatch } = await loadModule(
  '../lib/server/retention-policy.ts',
);
beforeEach(() => {
  now = CUTOFF;
  connection = new DatabaseSync(':memory:');
  connection.exec('PRAGMA foreign_keys=ON;' + migrations.join('\n'));
  photos.clear();
  removed.length = 0;
});
afterEach(() => connection.close());
after(() => {
  Date.now = realNow;
});
const key = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const digest = (value) => createHash('sha256').update(value).digest('hex');
function seedRoom({ createdAt = CUTOFF - DAY, expiresAt = createdAt + 14 * DAY } = {}) {
  const room = { id: crypto.randomUUID(), teacherKey: key(), taskId: crypto.randomUUID() };
  room.photo = `rooms/${room.id}/task.png`;
  connection
    .prepare(
      'INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count,amc_year) VALUES(?,?,?,?,?,?,1,2025)',
    )
    .run(
      room.id,
      crypto.randomUUID(),
      'Сохранённая подборка',
      digest(room.teacherKey),
      createdAt,
      expiresAt,
    );
  connection
    .prepare(
      'INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer,topic) VALUES(?,?,1,?,?,?,?)',
    )
    .run(room.taskId, room.id, room.photo, 'image/png', '5', 'Дроби');
  connection.prepare('INSERT INTO blobs(key,expires_at) VALUES(?,?)').run(room.photo, expiresAt);
  photos.set(room.photo, png);
  return room;
}
function seedAttempt(
  room,
  {
    finishedAt = CUTOFF - DAY,
    resultExpiresAt = finishedAt === null ? null : finishedAt + OLD_TTL,
    deadlineAt = finishedAt === null ? CUTOFF + DAY : finishedAt + 1000,
    startedAt = deadlineAt - DAY,
    solution = true,
    ttl = null,
    reason = 'completed',
    timingVersion = 2,
  } = {},
) {
  const attempt = { id: crypto.randomUUID(), key: key(), room };
  attempt.solution = solution ? `solutions/${attempt.id}/solution.png` : null;
  connection
    .prepare(
      'INSERT INTO attempts(id,room_id,secret_hash,order_json,position,started_at,task_started_at,finished_at,result_expires_at,deadline_at,timing_version,finish_reason,result_ttl_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      attempt.id,
      room.id,
      digest(attempt.key),
      JSON.stringify([room.taskId]),
      1,
      startedAt,
      0,
      finishedAt,
      resultExpiresAt,
      deadlineAt,
      timingVersion,
      finishedAt === null ? null : reason,
      ttl,
    );
  connection
    .prepare(
      'INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms,solution_key,solution_mime) VALUES(?,?,0,?,?,?,1,?,?,1250,?,?)',
    )
    .run(
      crypto.randomUUID(),
      attempt.id,
      room.taskId,
      crypto.randomUUID(),
      '5,00',
      startedAt,
      startedAt + 1250,
      attempt.solution,
      solution ? 'image/png' : null,
    );
  if (solution) {
    connection
      .prepare('INSERT INTO blobs(key,expires_at) VALUES(?,?)')
      .run(attempt.solution, resultExpiresAt ?? deadlineAt + OLD_TTL);
    photos.set(attempt.solution, png);
  }
  return attempt;
}
async function call(path, { method = 'GET', secret, teacher = false, body } = {}) {
  const response = await handle(
    new Request(`https://taskbattle.test/api${path}`, {
      method,
      headers: {
        ...(secret ? { [teacher ? 'x-teacher-key' : 'x-attempt-key']: secret } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return {
    status: response.status,
    data: response.headers.get('content-type')?.startsWith('image/')
      ? Buffer.from(await response.arrayBuffer())
      : await response.json(),
  };
}
const report = (attempt, teacher = false) =>
  call(`/attempts/${attempt.id}${teacher ? '/report' : ''}`, {
    secret: teacher ? attempt.room.teacherKey : attempt.key,
    teacher,
  });
const row = (attempt) => connection.prepare('SELECT * FROM attempts WHERE id=?').get(attempt.id);

test('schema migration preserves existing timestamps, answers and photos without a data backfill', () => {
  const old = new DatabaseSync(':memory:');
  old.exec('PRAGMA foreign_keys=ON;' + migrations.slice(0, -1).join('\n'));
  old.exec(
    "INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count) VALUES('room','request','Original','hash',10,20,1); INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer,topic) VALUES('task','room',1,'original.png','image/png','5','Topic'); INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,finished_at,result_expires_at) VALUES('attempt','room','hash','[\"task\"]',11,11,12,30); INSERT INTO blobs(key,expires_at) VALUES('original.png',20);",
  );
  old.exec(
    "INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms) VALUES('answer','attempt',0,'task','answer-request','5',1,11,12,1)",
  );
  const before = old.prepare('SELECT * FROM attempts').get();
  const answerBefore = old.prepare('SELECT * FROM answers').get();
  old.exec(migrations.at(-1));
  const { result_ttl_ms, ...retained } = old.prepare('SELECT * FROM attempts').get();
  assert.deepEqual(retained, { ...before });
  assert.equal(result_ttl_ms, null);
  assert.deepEqual(old.prepare('SELECT * FROM answers').get(), answerBefore);
  assert.equal(old.prepare('SELECT expires_at FROM rooms').get().expires_at, 20);
  assert.equal(old.prepare('SELECT expires_at FROM blobs').get().expires_at, 20);
  assert.equal(old.prepare('SELECT count(*) AS n FROM retention_policy').get().n, 0);
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  old.close();
});

test('one fixed cutover extends only still-available legacy reports, including NULL expiry', async () => {
  const room = seedRoom();
  const cases = [-1, 0, 1].flatMap((delta) =>
    [false, true].map((missingExpiry) => {
      const finishedAt = CUTOFF - OLD_TTL + delta;
      return {
        delta,
        finishedAt,
        attempt: seedAttempt(room, {
          finishedAt,
          resultExpiresAt: missingExpiry ? null : finishedAt + OLD_TTL,
          timingVersion: missingExpiry ? 3 : 2,
        }),
      };
    }),
  );
  assert.equal(await ensureRetentionPolicy(), CUTOFF);
  now += 5 * DAY;
  assert.equal(await ensureRetentionPolicy(), CUTOFF);
  for (const { delta, finishedAt, attempt } of cases) {
    const result = await report(attempt);
    assert.equal(result.status, delta > 0 ? 200 : 410);
    assert.equal(row(attempt).finished_at, finishedAt);
    assert.equal(row(attempt).result_expires_at, finishedAt + (delta > 0 ? NEW_TTL : OLD_TTL));
    if (delta > 0) {
      assert.equal(result.data.resultExpiresAt, finishedAt + NEW_TTL);
      assert.equal(result.data.amcYear, 2025);
      assert.equal(result.data.report[0].correctAnswer, '5');
      assert.equal(result.data.report[0].topic, 'Дроби');
      assert.equal(result.data.report[0].answer, '5,00');
      assert.equal((await report(attempt, true)).status, 200);
    }
  }
});

test('late timeout uses its original deadline and never revives an already-expired legacy result', async () => {
  const room = seedRoom();
  const cases = [-1, 0, 1].map((delta) => {
    const deadline = CUTOFF - OLD_TTL + delta;
    return {
      delta,
      deadline,
      attempt: seedAttempt(room, {
        finishedAt: null,
        deadlineAt: delta === 0 ? null : deadline,
        startedAt: deadline - DAY,
      }),
    };
  });
  await ensureRetentionPolicy();
  now += 10 * DAY;
  for (const { delta, deadline, attempt } of cases) {
    const result = await report(attempt);
    assert.equal(result.status, delta > 0 ? 200 : 410);
    assert.equal(row(attempt).finished_at, deadline);
    assert.equal(row(attempt).finish_reason, 'timeout');
    assert.equal(row(attempt).result_expires_at, deadline + (delta > 0 ? NEW_TTL : OLD_TTL));
  }
});

test('an old in-flight worker cannot shorten a classified 28-day result on access or cleanup', async () => {
  const room = seedRoom({ createdAt: CUTOFF - 15 * DAY, expiresAt: CUTOFF - DAY });
  const accessed = seedAttempt(room, { finishedAt: null });
  const scheduled = seedAttempt(room, { finishedAt: null });
  const missingExpiry = seedAttempt(room, { finishedAt: null, timingVersion: 3 });
  const expired = seedAttempt(room, { finishedAt: CUTOFF - OLD_TTL });
  await ensureRetentionPolicy();
  await migrateRetentionBatch();
  assert.equal(row(accessed).result_ttl_ms, NEW_TTL);
  assert.equal(row(scheduled).result_ttl_ms, NEW_TTL);
  assert.equal(row(missingExpiry).result_ttl_ms, NEW_TTL);
  assert.equal(row(expired).result_ttl_ms, OLD_TTL);
  const finishedAt = CUTOFF + 1000;
  // A request already executing in the previous deployment writes its old TTL
  // after the new policy has classified these still-active attempts.
  for (const attempt of [accessed, scheduled, missingExpiry])
    connection
      .prepare(
        "UPDATE attempts SET finished_at=?,result_expires_at=?,finish_reason='completed' WHERE id=?",
      )
      .run(finishedAt, attempt === missingExpiry ? null : finishedAt + OLD_TTL, attempt.id);
  now = finishedAt + 4 * DAY;
  const result = await report(accessed);
  assert.equal(result.status, 200);
  assert.equal(result.data.resultExpiresAt, finishedAt + NEW_TTL);
  assert.equal(row(accessed).result_expires_at, finishedAt + NEW_TTL);
  const repairedMissing = await report(missingExpiry);
  assert.equal(repairedMissing.status, 200);
  assert.equal(repairedMissing.data.resultExpiresAt, finishedAt + NEW_TTL);
  await cleanup();
  assert.equal(row(scheduled).result_expires_at, finishedAt + NEW_TTL);
  assert.equal(photos.has(scheduled.solution), true);
  assert.equal(photos.has(room.photo), true);
  assert.equal(row(expired), undefined);
  assert.equal((await report(expired)).status, 410);
});

test('existing room dates extend from creation only; expired rooms stay closed at exact cutoff', async () => {
  const live = seedRoom({ createdAt: CUTOFF - DAY, expiresAt: CUTOFF + 1 });
  const expired = seedRoom({ createdAt: CUTOFF - DAY, expiresAt: CUTOFF });
  await ensureRetentionPolicy();
  now += 2 * DAY;
  const result = await call(`/rooms/${live.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.data.createdAt, CUTOFF - DAY);
  assert.equal(result.data.expiresAt, CUTOFF + 13 * DAY);
  assert.equal((await call(`/rooms/${expired.id}`)).status, 410);
  now = CUTOFF + 13 * DAY - 1;
  assert.equal((await call(`/rooms/${live.id}`)).status, 200);
  now++;
  assert.equal((await call(`/rooms/${live.id}`)).status, 410);
  assert.equal(
    (
      await call(`/rooms/${live.id}/start`, {
        method: 'POST',
        body: { attemptId: crypto.randomUUID(), attemptKey: key() },
      })
    ).status,
    410,
  );
});

test('reports and both photo types remain available through day28 minus1ms, with shared photos retained for later results', async () => {
  const room = seedRoom({ createdAt: CUTOFF - 15 * DAY, expiresAt: CUTOFF - DAY });
  const earlier = seedAttempt(room, { finishedAt: CUTOFF - DAY });
  const later = seedAttempt(room, { finishedAt: CUTOFF });
  await ensureRetentionPolicy();
  await migrateRetentionBatch();
  now = CUTOFF + 27 * DAY - 1;
  await cleanup();
  const result = await report(earlier);
  assert.equal(result.status, 200);
  assert.equal(result.data.summary.totalMs, 1250);
  for (const path of [result.data.report[0].photo, result.data.report[0].solutionPhoto]) {
    const studentPhoto = await call(path.slice(4), { secret: earlier.key });
    assert.equal(studentPhoto.status, 200);
    assert.deepEqual(studentPhoto.data, png);
    assert.equal(
      (await call(path.slice(4), { secret: room.teacherKey, teacher: true })).status,
      200,
    );
    assert.equal((await call(path.slice(4), { secret: key() })).status, 403);
  }
  now++;
  assert.equal((await report(earlier)).status, 410);
  await cleanup();
  assert.equal(photos.has(earlier.solution), false);
  assert.equal(photos.has(room.photo), true);
  assert.equal((await report(later)).status, 200);
  now = CUTOFF + NEW_TTL;
  await cleanup();
  assert.equal((await report(later)).status, 410);
  assert.equal(photos.has(later.solution), false);
  assert.equal(photos.has(room.photo), false);
});

test('bounded migration does not let cleanup delete an unprocessed still-valid report or its photos', async () => {
  const room = seedRoom({ createdAt: CUTOFF - 15 * DAY, expiresAt: CUTOFF - DAY });
  const attempts = [];
  for (let i = 0; i < 501; i++) attempts.push(seedAttempt(room, { finishedAt: CUTOFF - DAY }));
  await ensureRetentionPolicy();
  now += 4 * DAY;
  await cleanup();
  assert.equal(connection.prepare('SELECT count(*) AS n FROM attempts').get().n, 501);
  assert.equal(removed.length, 0);
  assert.equal(photos.has(room.photo), true);
  for (const attempt of attempts) assert.equal(photos.has(attempt.solution), true);
  await cleanup();
  assert.equal(
    connection.prepare('SELECT count(*) AS n FROM attempts WHERE result_ttl_ms IS NULL').get().n,
    0,
  );
  assert.equal(connection.prepare('SELECT count(*) AS n FROM attempts').get().n, 501);
});

test('repeated reads and cleanup do not reset a completed result deadline or delete exported external sheets', async () => {
  const room = seedRoom({ createdAt: CUTOFF - 15 * DAY, expiresAt: CUTOFF - DAY });
  const attempt = seedAttempt(room, { finishedAt: CUTOFF });
  connection
    .prepare(
      'INSERT INTO sheet_exports(attempt_id,format,document_id,sheet_id,marker,payload,completed) VALUES(?,?,?,?,?,?,1)',
    )
    .run(attempt.id, 'free', 'external-test-document', 123, 'test-marker', '{}');
  await ensureRetentionPolicy();
  const initial = await report(attempt);
  assert.equal(initial.data.resultExpiresAt, CUTOFF + NEW_TTL);
  now += 20 * DAY;
  assert.equal((await report(attempt, true)).data.resultExpiresAt, initial.data.resultExpiresAt);
  await cleanup();
  assert.equal(row(attempt).result_expires_at, initial.data.resultExpiresAt);
  const realFetch = globalThis.fetch;
  const externalCalls = [];
  globalThis.fetch = async (...args) => {
    externalCalls.push(args);
    throw new Error('Unexpected external request during cleanup');
  };
  try {
    now = CUTOFF + NEW_TTL;
    await cleanup();
    await cleanup();
    assert.equal(row(attempt), undefined);
    assert.equal((await report(attempt)).status, 410);
    assert.deepEqual(externalCalls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
