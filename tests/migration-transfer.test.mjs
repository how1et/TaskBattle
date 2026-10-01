import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadModule } from './load-module.mjs';
import {
  downloadSnapshot,
  migrationClient,
  readMigrationSecret,
  TABLES,
  validateSource,
  verifySnapshot,
} from '../scripts/migration-transfer.mjs';
import { restoreMigration } from '../scripts/restore-migration.mjs';
import { migrateDatabase } from '../runtime/migrate.mjs';

const key = 'a'.repeat(64);
const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=',
  'base64',
);
const migrationFiles = (await readdir(new URL('../drizzle/', import.meta.url)))
  // The source is the deployed Cloudflare schema, before Yandex's export ledger.
  .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 6)
  .sort();
const migrations = await Promise.all(
  migrationFiles.map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8')),
);

async function fixture(t) {
  const conn = new DatabaseSync(':memory:');
  t.after(() => conn.close());
  conn.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) conn.exec(migration);
  conn.exec(`
    INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count,amc_year)
      VALUES('room','create','Олимпиада','teacher-hash',10,20,1,2025);
    INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer,topic)
      VALUES('task','room',1,'rooms/room/task','image/png','5','Дроби');
    INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,finished_at,result_expires_at,deadline_at,timing_version,selected_task_id)
      VALUES('attempt','room','attempt-hash','["task"]',11,12,13,14,15,3,'task');
    INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms,solution_key,solution_mime,solution_digest,revision)
      VALUES('answer','attempt',0,'task','answer-request','5',1,11,13,2,'solutions/answer','image/png','digest',2);
    INSERT INTO attempt_intervals(id,attempt_id,task_id,owner,started_at,duration_ms,closed_at)
      VALUES('interval','attempt','task','owner',11,2,13);
    INSERT INTO attempt_operations(attempt_id,request_id,payload_hash,token)
      VALUES('attempt','operation-b','payload-b','token-b'),('attempt','operation-a','payload-a','token-a');
    INSERT INTO sheet_exports(attempt_id,format,document_id,sheet_id,marker,payload,completed)
      VALUES('attempt','amc8','old-google-document',123,'marker','{"saved":true}',1);
    INSERT INTO blobs(key,expires_at,state) VALUES('rooms/room/task',20,'live'),('solutions/answer',14,'live'),('orphan/upload',0,'live');
    INSERT INTO expired_attempts(id,secret_hash,teacher_hash,reason) VALUES('expired','expired-secret','expired-teacher','result');
    INSERT INTO rate_limits(key,hits,expires_at) VALUES('limit',1,1);
    INSERT INTO cancelled_answers(attempt_id,request_id) VALUES('attempt','cancelled');
  `);
  const objects = new Map([
    ['rooms/room/task', photo],
    ['solutions/answer', photo],
    ['orphan/upload', photo],
    ['unregistered/private', photo],
  ]);
  const env = {
    MIGRATION_SECRET: key,
    MIGRATION_DRAIN: '1',
    DB: {
      prepare(query) {
        let args = [];
        return {
          bind(...values) {
            args = values;
            return this;
          },
          async first() {
            return conn.prepare(query).get(...args) || null;
          },
          async all() {
            return { results: conn.prepare(query).all(...args) };
          },
          async run() {
            return conn.prepare(query).run(...args);
          },
        };
      },
    },
    BUCKET: {
      async get(objectKey) {
        return objects.has(objectKey) ? { body: objects.get(objectKey) } : null;
      },
    },
  };
  globalThis.__taskbattleTestEnv = env;
  const migrationApi = await loadModule('../lib/server/migration.ts');
  async function handle(req) {
    try {
      return await migrationApi.handleMigration(req, new URL(req.url).pathname.split('/').slice(3));
    } catch (error) {
      if (!error.status) throw error;
      return Response.json({ code: error.code }, { status: error.status });
    }
  }
  async function call(
    resource,
    { method = 'GET', supplied = key, snapshot, confirm = false } = {},
  ) {
    return handle(
      new Request(`https://source.example/api/migration/${resource}`, {
        method,
        headers: {
          ...(supplied ? { 'x-migration-key': supplied } : {}),
          ...(snapshot ? { 'x-migration-snapshot': String(snapshot) } : {}),
          ...(confirm ? { 'x-confirm-migration-window': 'yes' } : {}),
        },
      }),
    );
  }
  const freeze = async () => (await call('freeze', { method: 'POST', confirm: true })).json();
  const client = migrationClient({
    sourceUrl: 'https://source.example',
    secret: key,
    fetchImpl: async (url, options) => handle(new Request(url, options)),
  });
  return { conn, objects, env, migrationApi, call, freeze, client };
}

test('retired source cannot unfreeze while the transition bridge is configured', async (t) => {
  const state = await fixture(t);
  await state.freeze();
  state.env.MIGRATION_TARGET_ORIGIN = 'https://destination.example';
  const response = await state.call('unfreeze', { method: 'POST', confirm: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'bridge-source-retired');
  assert.equal(state.conn.prepare('SELECT frozen FROM migration_gate').get().frozen, 1);
  assert.throws(
    () => state.conn.exec("UPDATE answers SET answer='stale'"),
    /TASKBATTLE_MAINTENANCE/,
  );
});

test('migration endpoint is disabled unless configured and rejects absent or incorrect credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('status', { supplied: null })).status, 403);
  assert.equal((await f.call('status', { supplied: 'b'.repeat(64) })).status, 403);
  assert.equal((await f.call('status', { supplied: 'short' })).status, 403);
  const status = await (await f.call('status')).json();
  assert.equal(status.schemaVersion, 6);
  assert.equal(status.frozen, false);
  assert.equal(status.snapshotReady, false);
  assert.equal(JSON.stringify(status).includes('teacher-hash'), false);
  delete f.env.MIGRATION_SECRET;
  assert.equal((await f.call('status')).status, 404);
  f.env.MIGRATION_SECRET = 'not-a-secret';
  assert.equal((await f.call('status')).status, 404);
});

test('freeze needs explicit confirmation and SQL blocks all three writes for every application table', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('freeze', { method: 'POST' })).status, 400);
  const status = await f.freeze();
  assert.equal(status.snapshotReady, true);
  assert.equal(status.requiredObjects, 2);
  assert.equal(
    f.conn
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'migration_freeze_%'",
      )
      .get().n,
    33,
  );
  for (const table of TABLES) {
    const column = f.conn.prepare(`PRAGMA table_info("${table}")`).all()[0].name;
    for (const query of [
      `INSERT INTO "${table}" SELECT * FROM "${table}"`,
      `UPDATE "${table}" SET "${column}"="${column}"`,
      `DELETE FROM "${table}"`,
    ])
      assert.throws(() => f.conn.exec(query), /TASKBATTLE_MAINTENANCE/, `${table}: ${query}`);
  }
  await assert.rejects(
    f.migrationApi.assertNotFrozen(),
    (error) => error.status === 503 && error.code === 'maintenance',
  );
  assert.equal((await f.call('unfreeze', { method: 'POST' })).status, 400);
  assert.equal((await f.call('unfreeze', { method: 'POST', confirm: true })).status, 200);
  await f.migrationApi.assertNotFrozen();
  f.conn.exec("UPDATE rate_limits SET hits=2 WHERE key='limit'");
});

test('freeze requires drain mode and counts overdue unfinished attempts until normal finalization', async (t) => {
  const f = await fixture(t);
  f.env.MIGRATION_DRAIN = '0';
  const disabled = await f.call('freeze', { method: 'POST', confirm: true });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).code, 'migration-drain-required');
  const initial = await (await f.call('status')).json();
  assert.equal(initial.drainEnabled, false);
  assert.equal(initial.activeAttempts, 0);
  assert.equal(initial.frozen, false);
  f.env.MIGRATION_DRAIN = '1';
  f.conn
    .exec(`INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,deadline_at)
    VALUES('overdue','room','overdue-secret','["task"]',0,0,1)`);
  const waiting = await (await f.call('status')).json();
  assert.equal(waiting.drainEnabled, true);
  assert.equal(waiting.activeAttempts, 1);
  assert.equal(waiting.snapshotReady, false);
  const rejected = await f.call('freeze', { method: 'POST', confirm: true });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'migration-active-attempts');
  assert.equal(f.conn.prepare('SELECT frozen FROM migration_gate').get().frozen, 0);
  assert.equal(
    f.conn.prepare("SELECT deadline_at FROM attempts WHERE id='overdue'").get().deadline_at,
    1,
  );
  f.conn.exec("UPDATE attempts SET finished_at=1,finish_reason='timeout' WHERE id='overdue'");
  const frozen = await f.freeze();
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.activeAttempts, 0);
  assert.equal(frozen.snapshotReady, true);
});

test('a start committing immediately before the freeze statement atomically prevents the migration window', async (t) => {
  const f = await fixture(t);
  const initial = await (await f.call('status')).json();
  assert.equal(initial.activeAttempts, 0);
  const prepare = f.env.DB.prepare;
  let raced = false;
  f.env.DB.prepare = (query) => {
    const statement = prepare(query);
    if (query.startsWith('UPDATE migration_gate SET frozen=1')) {
      const run = statement.run;
      statement.run = async () => {
        if (!raced) {
          raced = true;
          f.conn
            .exec(`INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,deadline_at)
            VALUES('late-start','room','late-secret','["task"]',11,11,9999999999999)`);
        }
        return run();
      };
    }
    return statement;
  };
  const response = await f.call('freeze', { method: 'POST', confirm: true });
  assert.equal(raced, true);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'migration-active-attempts');
  assert.equal(f.conn.prepare('SELECT frozen FROM migration_gate').get().frozen, 0);
  f.conn.exec("UPDATE attempts SET position=1 WHERE id='late-start'");
});

test('table reads require a frozen snapshot and reject arbitrary names, cursors and oversized pages', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('tables/rooms')).status, 409);
  const status = await f.freeze();
  assert.equal((await f.call('tables/rooms')).status, 409);
  const options = { snapshot: status.frozenAt };
  for (const name of ['migration_gate', 'sqlite_master', '__proto__', 'rooms;DELETE'])
    assert.equal((await f.call(`tables/${name}`, options)).status, 404);
  for (const query of [
    'limit=501',
    'limit=0',
    'limit=-1',
    'limit=1.5',
    'cursor=!!',
    'cursor=WyIxIiwiMiJd',
  ])
    assert.equal((await f.call(`tables/rooms?${query}`, options)).status, 400);
  const result = await (await f.call('tables/rooms', options)).json();
  assert.equal(result.rows[0].expires_at, 20);
  assert.equal(result.rows[0].teacher_hash, 'teacher-hash');
});

test('keyset pages preserve every row and composite key order without duplicates', async (t) => {
  const f = await fixture(t);
  const status = await f.freeze();
  for (const [table, columns] of Object.entries(f.migrationApi.MIGRATION_TABLES)) {
    const expected = f.conn
      .prepare(
        `SELECT * FROM "${table}" ORDER BY ${columns.map((column) => `"${column}"`).join(',')}`,
      )
      .all();
    const rows = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) });
      const response = await f.call(`tables/${table}?${query}`, { snapshot: status.frozenAt });
      assert.equal(response.status, 200);
      const page = await response.json();
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(rows, JSON.parse(JSON.stringify(expected)));
  }
});

test('unfreeze invalidates every old snapshot, including after immediate refreeze', async (t) => {
  const f = await fixture(t);
  const first = await f.freeze();
  assert.equal((await f.freeze()).frozenAt, first.frozenAt);
  await f.call('unfreeze', { method: 'POST', confirm: true });
  assert.equal((await f.call('tables/tasks', { snapshot: first.frozenAt })).status, 409);
  const second = await f.freeze();
  assert.ok(second.frozenAt > first.frozenAt);
  assert.equal((await f.call('tables/tasks', { snapshot: first.frozenAt })).status, 409);
});

test('object export is limited to registered required photographs and detects missing required bytes', async (t) => {
  const f = await fixture(t);
  const snapshot = (await f.freeze()).frozenAt;
  for (const objectKey of ['orphan/upload', 'unregistered/private', '../../.env'])
    assert.equal(
      (await f.call(`object?${new URLSearchParams({ key: objectKey })}`, { snapshot })).status,
      404,
    );
  const response = await f.call('object?key=rooms%2Froom%2Ftask', { snapshot });
  assert.equal(response.headers.get('x-migration-snapshot'), String(snapshot));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), photo);
  f.objects.delete('solutions/answer');
  assert.equal((await f.call('object?key=solutions%2Fanswer', { snapshot })).status, 409);
});

test('pending required deletion or absent registration makes snapshot unready', async (t) => {
  const f = await fixture(t);
  f.conn.exec(
    "UPDATE blobs SET state='deleting' WHERE key='solutions/answer'; DELETE FROM blobs WHERE key='rooms/room/task'",
  );
  const status = await f.freeze();
  assert.equal(status.snapshotReady, false);
  assert.equal(status.pendingObjectDeletions, 1);
  assert.equal(status.missingObjectRegistrations, 1);
});

test('a late orphan upload cannot commit an answer after the database freezes', async (t) => {
  const f = await fixture(t);
  await f.freeze();
  f.objects.set('orphan/upload', Buffer.from('late upload'));
  assert.throws(
    () => f.conn.exec("UPDATE answers SET solution_key='orphan/upload' WHERE id='answer'"),
    /TASKBATTLE_MAINTENANCE/,
  );
  const response = await f.call('status');
  assert.equal((await response.json()).requiredObjects, 2);
});

test('snapshot export verifies hashes and retains timestamps, tombstones and export metadata while excluding orphan objects', async (t) => {
  const f = await fixture(t);
  const base = await mkdtemp(path.join(os.tmpdir(), 'taskbattle-migration-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'snapshot');
  await assert.rejects(downloadSnapshot(f.client, directory, { paceMs: 0 }), /frozen/);
  await f.freeze();
  const result = await downloadSnapshot(f.client, directory, { paceMs: 0 });
  assert.equal(result.objects, 2);
  const manifest = await verifySnapshot(directory);
  assert.equal(
    manifest.objects.some((object) => object.key === 'orphan/upload'),
    false,
  );
  for (const table of TABLES) {
    const actual = [];
    for (const entry of manifest.tables.filter((entry) => entry.table === table))
      actual.push(...JSON.parse(await readFile(path.join(directory, entry.path), 'utf8')));
    const expected = f.conn.prepare(`SELECT * FROM "${table}"`).all();
    assert.deepEqual(
      new Set(actual.map((row) => JSON.stringify(row))),
      new Set(expected.map((row) => JSON.stringify(row))),
    );
  }
  await assert.rejects(downloadSnapshot(f.client, directory, { paceMs: 0 }), /EEXIST/);
  await writeFile(path.join(directory, manifest.objects[0].path), 'corruption');
  await assert.rejects(verifySnapshot(directory), /checksum/);
});

test('an incomplete object export never produces a valid manifest or silently resumes', async (t) => {
  const f = await fixture(t);
  const base = await mkdtemp(path.join(os.tmpdir(), 'taskbattle-migration-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'snapshot');
  f.objects.delete('solutions/answer');
  await f.freeze();
  await assert.rejects(downloadSnapshot(f.client, directory, { paceMs: 0 }), /HTTP 409/);
  assert.equal((await readdir(directory)).includes('INCOMPLETE'), true);
  assert.equal((await readdir(directory)).includes('manifest.json'), false);
  await assert.rejects(verifySnapshot(directory), /incomplete/);
});

test('export rejects snapshot changes during pagination', async (t) => {
  const f = await fixture(t);
  const base = await mkdtemp(path.join(os.tmpdir(), 'taskbattle-migration-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await f.freeze();
  let changed = false;
  const client = {
    origin: f.client.origin,
    async request(resource, options) {
      const response = await f.client.request(resource, options);
      if (!changed && resource.startsWith('tables/')) {
        changed = true;
        await f.call('unfreeze', { method: 'POST', confirm: true });
        await f.freeze();
      }
      return response;
    },
  };
  await assert.rejects(
    downloadSnapshot(client, path.join(base, 'snapshot'), { paceMs: 0 }),
    /HTTP 409/,
  );
});

test('transport requires HTTPS and secrets must be read from a separate local file', async (t) => {
  assert.equal(validateSource('https://source.example/'), 'https://source.example');
  assert.throws(() => validateSource('http://source.example', true), /HTTPS/);
  assert.throws(() => validateSource('http://localhost:3000'), /HTTPS/);
  assert.equal(validateSource('http://localhost:3000', true), 'http://localhost:3000');
  for (const source of [
    'https://user:pass@source.example',
    'https://source.example/path',
    'https://source.example/?key=secret',
  ])
    assert.throws(() => validateSource(source), /origin/);
  const base = await mkdtemp(path.join(os.tmpdir(), 'taskbattle-migration-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const filename = path.join(base, 'key');
  await writeFile(filename, key + '\n');
  assert.equal(await readMigrationSecret(filename), key);
  await assert.rejects(readMigrationSecret(new URL('../package.json', import.meta.url)), /outside/);
  await writeFile(filename, 'invalid');
  await assert.rejects(readMigrationSecret(filename), /64 hexadecimal/);
});

function destinationBucket(initial = []) {
  const objects = new Map(initial),
    writes = [];
  return {
    objects,
    writes,
    async get(key) {
      return objects.has(key) ? { body: objects.get(key) } : null;
    },
    async put(key, bytes) {
      writes.push(key);
      objects.set(key, Buffer.from(await new Response(bytes).arrayBuffer()));
    },
  };
}

async function exportedFixture(t, customize) {
  const source = await fixture(t);
  if (customize) await customize(source);
  const base = await mkdtemp(path.join(os.tmpdir(), 'taskbattle-restore-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'snapshot');
  const frozen = await source.freeze();
  await downloadSnapshot(source.client, directory, { paceMs: 0 });
  return {
    source,
    base,
    directory,
    frozen,
    filename: path.join(base, 'restored.sqlite'),
    manifest: await verifySnapshot(directory),
  };
}

test('real migration restore imports schema 6, preserves all data and photographs, and adopts only new schema 7', async (t) => {
  const now = Date.now();
  const state = await exportedFixture(t, (source) => {
    // Replaying 0004 would extend this room to 14 days and replace the NULL
    // finish_reason in the original completed attempt. Both must remain exact.
    source.conn
      .prepare(
        'INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'live-room',
        'live-request',
        'Живое занятие',
        'live-teacher',
        now - 60000,
        now + 3600000,
        1,
      );
    source.conn
      .prepare(
        'INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer,topic) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'live-task',
        'live-room',
        1,
        'rooms/live/task',
        'image/png',
        '=буквальный ответ',
        'Тема',
      );
    source.conn
      .prepare(
        'INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,deadline_at,timing_version,selected_task_id,state_version) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'active-attempt',
        'live-room',
        'live-secret',
        '["live-task"]',
        now - 30000,
        now - 5000,
        now + 123456,
        3,
        'live-task',
        4,
      );
    source.conn
      .prepare(
        'INSERT INTO attempt_intervals(id,attempt_id,task_id,owner,started_at,duration_ms) VALUES(?,?,?,?,?,?)',
      )
      .run('open-interval', 'active-attempt', 'live-task', 'owner', now - 5000, 2468);
    // The migration window starts only after draining existing attempts.
    source.conn
      .prepare('UPDATE attempts SET finished_at=?,finish_reason=? WHERE id=?')
      .run(now - 1, 'manual', 'active-attempt');
    source.conn
      .prepare('UPDATE attempt_intervals SET closed_at=? WHERE id=?')
      .run(now - 1, 'open-interval');
    source.conn
      .prepare('INSERT INTO blobs(key,expires_at,state) VALUES(?,?,?)')
      .run('rooms/live/task', now + 3600000, 'live');
    source.objects.set('rooms/live/task', photo);
  });
  assert.equal(state.manifest.schemaVersion, 6);
  assert.equal(
    state.source.conn
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='yandex_export_jobs'")
      .get().n,
    0,
  );
  const bucket = destinationBucket([['rooms/room/task', Buffer.from(photo)]]);
  const restored = await restoreMigration(state.directory, state.filename, bucket);
  assert.equal(restored.frozen, true);
  assert.equal(restored.objects, 3);
  assert.equal(
    bucket.writes.includes('rooms/room/task'),
    false,
    'an identical existing photo should not be replaced',
  );
  assert.equal(bucket.objects.has('orphan/upload'), false);
  for (const object of state.manifest.objects)
    assert.deepEqual(bucket.objects.get(object.key), state.source.objects.get(object.key));
  const connection = new DatabaseSync(state.filename);
  try {
    for (const [table, columns] of Object.entries(state.source.migrationApi.MIGRATION_TABLES)) {
      const query = `SELECT * FROM "${table}" ORDER BY ${columns.map((column) => `"${column}"`).join(',')}`;
      assert.deepEqual(
        connection.prepare(query).all(),
        state.source.conn.prepare(query).all(),
        table,
      );
    }
    const gate = connection
      .prepare('SELECT frozen,frozen_at FROM migration_gate WHERE singleton=1')
      .get();
    assert.deepEqual({ ...gate }, { frozen: 1, frozen_at: state.frozen.frozenAt });
    const journal = connection
      .prepare('SELECT id,adopted FROM __taskbattle_migrations ORDER BY id')
      .all();
    assert.deepEqual(
      journal.map((row) => ({ ...row })),
      [...Array.from({ length: 7 }, (_, id) => ({ id, adopted: 1 })), { id: 7, adopted: 0 }],
    );
    for (const table of ['yandex_export_books', 'yandex_export_jobs'])
      assert.equal(connection.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0);
    assert.equal(
      connection.prepare("SELECT finish_reason FROM attempts WHERE id='attempt'").get()
        .finish_reason,
      null,
    );
    assert.equal(
      connection.prepare("SELECT expires_at FROM rooms WHERE id='live-room'").get().expires_at,
      now + 3600000,
    );
    assert.equal(
      connection.prepare("SELECT deadline_at FROM attempts WHERE id='active-attempt'").get()
        .deadline_at,
      now + 123456,
    );
    assert.equal(
      connection.prepare("SELECT result_expires_at FROM attempts WHERE id='attempt'").get()
        .result_expires_at,
      14,
    );
    assert.equal(
      connection.prepare("SELECT reason FROM expired_attempts WHERE id='expired'").get().reason,
      'result',
    );
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.throws(
      () => connection.exec("UPDATE answers SET answer='lost' WHERE id='answer'"),
      /TASKBATTLE_MAINTENANCE/,
    );
  } finally {
    connection.close();
  }
  const repeated = migrateDatabase(state.filename);
  assert.equal(repeated.status, 'up-to-date');
  assert.equal(repeated.applied, 0);
});

test('restore refuses damaged or missing snapshot files before creating a database or uploading photos', async (t) => {
  const state = await exportedFixture(t);
  const bucket = destinationBucket();
  const cases = [
    { path: state.manifest.tables[0].path, change: 'corrupt' },
    { path: state.manifest.objects[0].path, change: 'corrupt' },
    { path: state.manifest.objects[0].path, change: 'missing' },
    { path: 'manifest.json', change: 'corrupt' },
  ];
  for (const [index, item] of cases.entries()) {
    const file = path.join(state.directory, item.path);
    const original = await readFile(file);
    const filename = path.join(state.base, `rejected-${index}.sqlite`);
    try {
      if (item.change === 'missing') await rm(file);
      else await writeFile(file, 'damaged snapshot');
      await assert.rejects(restoreMigration(state.directory, filename, bucket));
      await assert.rejects(stat(filename), { code: 'ENOENT' });
      assert.equal(bucket.writes.length, 0);
    } finally {
      await writeFile(file, original);
    }
  }
});

test('restore refuses an existing database and concurrent restorers cannot both create the same target', async (t) => {
  const state = await exportedFixture(t);
  const marker = Buffer.from('existing database must remain untouched');
  await writeFile(state.filename, marker);
  const bucket = destinationBucket();
  await assert.rejects(
    restoreMigration(state.directory, state.filename, bucket),
    /new database path/,
  );
  assert.deepEqual(await readFile(state.filename), marker);
  assert.equal(bucket.writes.length, 0);
  const target = path.join(state.base, 'concurrent.sqlite');
  const results = await Promise.allSettled([
    restoreMigration(state.directory, target, bucket),
    restoreMigration(state.directory, target, bucket),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const connection = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 1);
    assert.equal(connection.prepare('SELECT frozen FROM migration_gate').get().frozen, 1);
  } finally {
    connection.close();
  }
});

test('photo collision or damaged upload leaves the imported database frozen and refuses overwriting existing objects', async (t) => {
  const state = await exportedFixture(t);
  const conflict = Buffer.from('different existing photo');
  const collisionBucket = destinationBucket([['rooms/room/task', conflict]]);
  await assert.rejects(
    restoreMigration(state.directory, state.filename, collisionBucket),
    /collision/,
  );
  assert.deepEqual(collisionBucket.objects.get('rooms/room/task'), conflict);
  assert.equal(collisionBucket.writes.includes('rooms/room/task'), false);
  const frozen = new DatabaseSync(state.filename, { readOnly: true });
  try {
    assert.equal(frozen.prepare('SELECT frozen FROM migration_gate').get().frozen, 1);
    assert.equal(frozen.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 1);
  } finally {
    frozen.close();
  }
  const corrupted = destinationBucket();
  corrupted.put = async (key) => corrupted.objects.set(key, Buffer.from('damaged upload'));
  const other = path.join(state.base, 'bad-upload.sqlite');
  await assert.rejects(restoreMigration(state.directory, other, corrupted), /verification failed/);
  const failed = new DatabaseSync(other, { readOnly: true });
  try {
    assert.equal(failed.prepare('SELECT frozen FROM migration_gate').get().frozen, 1);
  } finally {
    failed.close();
  }
});
