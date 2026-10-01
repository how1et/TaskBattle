import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isSafeWalVersion, openSqliteDatabase } from '../runtime/sqlite.mjs';
import {
  getSchemaSnapshot,
  migrateDatabase,
  MIGRATION_TABLE,
  readMigrationFiles,
} from '../runtime/migrate.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'taskbattle-sqlite-test-'));
  const resources = [];
  t.after(() => {
    for (const resource of resources.reverse()) resource.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filename: join(directory, 'persistent.sqlite'),
    keep: (resource) => {
      resources.push(resource);
      return resource;
    },
  };
}

function seedImportedData(connection) {
  // Deliberately differ from every historical backfill formula. These are
  // synthetic records; importing must not change their timestamps or answers.
  connection
    .prepare(
      'INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count,amc_year) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'synthetic-room',
      'synthetic-create',
      'Synthetic fixture',
      'synthetic-hash',
      1234,
      9000000000000,
      1,
      2026,
    );
  connection
    .prepare(
      'INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer,topic) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'synthetic-task',
      'synthetic-room',
      0,
      'synthetic/file.png',
      'image/png',
      '5',
      'Synthetic',
    );
  connection
    .prepare(
      'INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,finished_at,result_expires_at,deadline_at,finish_reason,timing_version,state_version,selected_task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'synthetic-attempt',
      'synthetic-room',
      'synthetic-hash',
      '["synthetic-task"]',
      2000,
      2100,
      2500,
      3000,
      null,
      null,
      3,
      7,
      'synthetic-task',
    );
  connection
    .prepare(
      'INSERT INTO answers(id,attempt_id,position,task_id,request_id,answer,correct,started_at,answered_at,duration_ms,received_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'synthetic-answer',
      'synthetic-attempt',
      0,
      'synthetic-task',
      'synthetic-submit',
      '5',
      1,
      2100,
      2500,
      321,
      2499,
      2,
    );
  connection
    .prepare('INSERT INTO blobs(key,expires_at,state) VALUES(?,?,?)')
    .run('synthetic/file.png', 2800, 'live');
}

function dataSnapshot(connection) {
  return Object.fromEntries(
    getSchemaSnapshot(connection).tables.map(({ name }) => [
      name,
      connection
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
}

function importedDatabase(filename) {
  const connection = new DatabaseSync(filename);
  for (const migration of readMigrationFiles()) connection.exec(migration.sql);
  seedImportedData(connection);
  connection.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  return connection;
}

test('persistent SQLite survives close/reopen and enables durable WAL and foreign keys', async (t) => {
  const { filename, keep } = fixture(t);
  const database = openSqliteDatabase(filename, { busyTimeoutMs: 1234 });
  database.connection.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const insert = await database.prepare('INSERT INTO items(value) VALUES (?)').bind('saved').run();
  assert.deepEqual(insert.meta, { changes: 1, last_row_id: 1 });
  assert.equal(database.connection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(database.connection.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(database.connection.prepare('PRAGMA busy_timeout').get().timeout, 1234);
  assert.equal(database.connection.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  database.close();
  const reopened = keep(openSqliteDatabase(filename));
  assert.deepEqual(await reopened.prepare('SELECT * FROM items').first(), {
    id: 1,
    value: 'saved',
  });
  assert.equal(await reopened.prepare('SELECT value FROM items').first('value'), 'saved');
  assert.equal(await reopened.prepare('SELECT value FROM items WHERE id=2').first(), null);
  await assert.rejects(
    reopened.prepare('SELECT value FROM items').first('absent'),
    /column is absent/,
  );
});

test('all and first fully execute RETURNING while SELECT metadata has no stale changes', async (t) => {
  const { filename, keep } = fixture(t);
  const database = keep(openSqliteDatabase(filename));
  database.connection.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO items(value) VALUES(?) RETURNING id,value');
  const result = await insert.bind('one').all();
  assert.deepEqual(result.results, [{ id: 1, value: 'one' }]);
  assert.deepEqual(result.meta, { changes: 1, last_row_id: 1 });
  assert.deepEqual(await insert.bind('two').first(), { id: 2, value: 'two' });
  const update = await database
    .prepare("UPDATE items SET value=value||'!' RETURNING id")
    .first('id');
  assert.equal(update, 1);
  const selected = await database.prepare('SELECT * FROM items ORDER BY id').all();
  assert.deepEqual(selected.results, [
    { id: 1, value: 'one!' },
    { id: 2, value: 'two!' },
  ]);
  assert.equal(selected.meta.changes, 0);
  assert.equal(
    (await database.prepare('UPDATE items SET value=? WHERE id=-1').bind('none').all()).meta
      .changes,
    0,
  );
});

test('batch commits synchronously before yielding and rolls back every statement on failure', async (t) => {
  const { filename, keep } = fixture(t);
  const database = keep(openSqliteDatabase(filename));
  database.connection.exec(
    'CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)',
  );
  const completed = database.batch([
    database.prepare('INSERT INTO items(value) VALUES(?) RETURNING id').bind('one'),
    database.prepare('INSERT INTO items(value) VALUES(?)').bind('two'),
    database.prepare('SELECT value FROM items ORDER BY id'),
  ]);
  // This read happens before awaiting batch: the transaction has already ended.
  assert.equal(database.connection.isTransaction, false);
  assert.equal(database.connection.prepare('SELECT count(*) AS n FROM items').get().n, 2);
  const results = await completed;
  assert.deepEqual(results[0].results, [{ id: 1 }]);
  assert.equal(results[1].meta.changes, 1);
  assert.deepEqual(results[2].results, [{ value: 'one' }, { value: 'two' }]);
  assert.equal(results[2].meta.changes, 0);
  await assert.rejects(
    database.batch([
      database.prepare('UPDATE items SET value=? WHERE id=1').bind('changed'),
      database.prepare('INSERT INTO items(value) VALUES(?)').bind('three'),
      database.prepare('INSERT INTO items(value) VALUES(?)').bind('two'),
    ]),
    /UNIQUE/,
  );
  assert.deepEqual((await database.prepare('SELECT value FROM items ORDER BY id').all()).results, [
    { value: 'one' },
    { value: 'two' },
  ]);
  assert.equal(database.connection.isTransaction, false);
  assert.throws(() => database.prepare('/* caller cannot escape a batch */ COMMIT'), /Transaction/);
  const secondFixture = fixture(t);
  const other = secondFixture.keep(openSqliteDatabase(secondFixture.filename));
  await assert.rejects(database.batch([other.prepare('SELECT 1')]), /belong/);
});

test('foreign-key rejection and cascading deletes run against the actual application schema', async (t) => {
  const { filename, keep } = fixture(t);
  migrateDatabase(filename);
  const database = keep(openSqliteDatabase(filename));
  await assert.rejects(
    database
      .prepare('INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer) VALUES(?,?,?,?,?,?)')
      .bind('orphan', 'missing', 0, 'synthetic/photo', 'image/png', '5')
      .run(),
    /FOREIGN KEY/,
  );
  seedImportedData(database.connection);
  await database.prepare('DELETE FROM rooms WHERE id=?').bind('synthetic-room').run();
  assert.equal(await database.prepare('SELECT count(*) AS n FROM tasks').first('n'), 0);
  assert.equal(await database.prepare('SELECT count(*) AS n FROM attempts').first('n'), 0);
  assert.equal(await database.prepare('SELECT count(*) AS n FROM answers').first('n'), 0);
});

test('memory databases require the explicit test-only flag and unsafe WAL versions are rejected', (t) => {
  assert.throws(() => openSqliteDatabase(':memory:'), /In-memory SQLite is disabled/);
  assert.throws(() => openSqliteDatabase(''), /file path/);
  assert.throws(() => openSqliteDatabase('file:transient?mode=memory&cache=shared'), /URI/);
  const database = openSqliteDatabase(':memory:', { allowMemoryForTests: true });
  t.after(() => database.close());
  for (const version of ['3.44.6', '3.50.7', '3.51.3', '3.53.3', '4.0.0'])
    assert.equal(isSafeWalVersion(version), true, version);
  for (const version of ['3.44.5', '3.45.9', '3.50.6', '3.51.2', 'garbage'])
    assert.equal(isSafeWalVersion(version), false, version);
});

test('fresh initialization replays all existing SQL migrations once and checks its journal', (t) => {
  const { filename, keep } = fixture(t);
  const migrations = readMigrationFiles();
  assert.ok(migrations.length >= 6);
  assert.equal(migrations[0].name, '0000_flaky_major_mapleleaf.sql');
  const first = migrateDatabase(filename);
  assert.deepEqual(first, {
    status: 'migrated',
    applied: migrations.length,
    adopted: 0,
    total: migrations.length,
  });
  const connection = new DatabaseSync(filename);
  seedImportedData(connection);
  const before = dataSnapshot(connection);
  connection.close();
  assert.deepEqual(migrateDatabase(filename), {
    status: 'up-to-date',
    applied: 0,
    adopted: 0,
    total: migrations.length,
  });
  const reopened = keep(new DatabaseSync(filename));
  assert.deepEqual(dataSnapshot(reopened), before);
  assert.equal(
    reopened.prepare(`SELECT count(*) AS n FROM ${MIGRATION_TABLE}`).get().n,
    migrations.length,
  );
  reopened.prepare(`UPDATE ${MIGRATION_TABLE} SET checksum=? WHERE id=0`).run('tampered');
  assert.throws(() => migrateDatabase(filename), /journal does not match/);
  assert.deepEqual(dataSnapshot(reopened), before);
});

test('adoption requires explicit authorization and preserves every imported application row', (t) => {
  const { filename, keep } = fixture(t);
  const imported = importedDatabase(filename);
  const before = dataSnapshot(imported);
  imported.close();
  assert.throws(() => migrateDatabase(filename), /--adopt-existing/);
  const afterRejected = new DatabaseSync(filename);
  assert.equal(
    afterRejected
      .prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name=?')
      .get(MIGRATION_TABLE).n,
    0,
  );
  assert.deepEqual(dataSnapshot(afterRejected), before);
  afterRejected.close();
  const adopted = migrateDatabase(filename, { adoptExisting: true });
  assert.equal(adopted.status, 'adopted');
  assert.equal(adopted.applied, 0);
  assert.equal(adopted.adopted, readMigrationFiles().length);
  const connection = keep(new DatabaseSync(filename));
  assert.deepEqual(dataSnapshot(connection), before);
  assert.equal(
    connection.prepare(`SELECT count(*) AS n FROM ${MIGRATION_TABLE} WHERE adopted=1`).get().n,
    readMigrationFiles().length,
  );
  assert.equal(migrateDatabase(filename).status, 'up-to-date');
  assert.deepEqual(dataSnapshot(connection), before);
});

test('adoption refuses missing indexes, changed columns, and changed triggers before creating a journal', (t) => {
  const changes = [
    'DROP INDEX answers_attempt_task',
    'ALTER TABLE rooms ADD COLUMN unexpected TEXT',
    "CREATE TRIGGER unexpected_trigger BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  ];
  for (const change of changes) {
    const { filename } = fixture(t);
    const connection = importedDatabase(filename);
    connection.exec(change);
    const before = dataSnapshot(connection);
    assert.throws(
      () => migrateDatabase(filename, { adoptExisting: true }),
      /schema does not match/,
    );
    assert.equal(
      connection
        .prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name=?')
        .get(MIGRATION_TABLE).n,
      0,
    );
    assert.deepEqual(dataSnapshot(connection), before);
    connection.close();
  }
});

test('failed migration rolls back both schema and journal and never overwrites a non-database file', (t) => {
  const { filename, directory } = fixture(t);
  const migrationsDirectory = join(directory, 'migrations');
  mkdirSync(migrationsDirectory);
  writeFileSync(
    join(migrationsDirectory, '0000_first.sql'),
    'CREATE TABLE first(id INTEGER PRIMARY KEY);',
  );
  writeFileSync(
    join(migrationsDirectory, '0001_failed.sql'),
    'CREATE TABLE second(id INTEGER PRIMARY KEY); INSERT INTO absent VALUES(1);',
  );
  assert.throws(() => migrateDatabase(filename, { migrationsDirectory }), /no such table/);
  const connection = new DatabaseSync(filename);
  assert.equal(
    connection
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get().n,
    0,
  );
  connection.close();
  const invalid = join(directory, 'not-a-database.txt');
  writeFileSync(invalid, 'synthetic file that must remain untouched');
  const before = readFileSync(invalid);
  assert.throws(() => migrateDatabase(invalid), /not a database/);
  assert.deepEqual(readFileSync(invalid), before);
});

test('migration CLI requires an explicit file path and safely initializes a file twice', (t) => {
  const { filename } = fixture(t);
  const cli = fileURLToPath(new URL('../runtime/migrate.mjs', import.meta.url));
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /explicit --database/);
  const init = spawnSync(process.execPath, [cli, '--database', filename], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).status, 'migrated');
  const repeat = spawnSync(process.execPath, [cli, '--database', filename], { encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).status, 'up-to-date');
});
