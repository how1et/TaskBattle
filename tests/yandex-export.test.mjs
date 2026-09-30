import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { openSqliteDatabase } from '../runtime/sqlite.mjs';
import { migrateDatabase, readMigrationFiles, MIGRATION_TABLE } from '../runtime/migrate.mjs';
import {
  createYandexDiskClient,
  DiskError,
  validateTransferUrl,
  validateDiskPath,
  diskWebUrl,
} from '../runtime/yandex-disk.mjs';
import {
  appendResultWorksheet,
  createWorkbookExporter,
  reportSheetData,
  sha256,
  verifyWorkbookMarker,
} from '../runtime/workbook.mjs';

const path = 'disk:/Результаты TASKBATTLE.xlsx';
const report = (attemptId = 'synthetic-attempt') => ({
  attemptId,
  title: '=HYPERLINK("https://invalid.example")',
  finishedAt: 1790794800000,
  finishReason: 'manual',
  timingIncomplete: true,
  count: 4,
  summary: { totalMs: 4567, submitted: 2 },
  report: [
    { ordinal: 1, topic: '=1+1', durationMs: 1234, correct: true, submitted: true },
    { ordinal: 2, topic: 'Skipped', durationMs: 1000, correct: null, submitted: false },
    { ordinal: 4, topic: '+SUM(A1:A2)', durationMs: 2333, correct: false, submitted: true },
  ],
});

class FakeDisk {
  bytes = null;
  pending = null;
  uploads = 0;
  mode = 'normal';
  hook = null;
  async stat() {
    return this.bytes ? { sha256: sha256(this.bytes), size: this.bytes.length } : null;
  }
  async download() {
    return Buffer.from(this.bytes);
  }
  async prepareUpload(_path, overwrite) {
    if (this.hook) await this.hook();
    return async (bytes) => {
      this.uploads++;
      assert.equal(overwrite, Boolean(this.bytes));
      const mode = this.mode;
      this.mode = 'normal';
      if (mode === 'definite') throw new DiskError('disk-upload');
      if (mode === 'late') {
        this.pending = Buffer.from(bytes);
        throw new DiskError('disk-network', { ambiguous: true });
      }
      this.bytes = Buffer.from(bytes);
      if (mode === 'lost-ack') throw new DiskError('disk-network', { ambiguous: true });
    };
  }
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'taskbattle-yandex-test-'));
  const filename = join(directory, 'database.sqlite');
  migrateDatabase(filename);
  const resources = [];
  const open = () => {
    const database = openSqliteDatabase(filename);
    resources.push(database);
    return database;
  };
  const database = open(),
    disk = new FakeDisk();
  t.after(() => {
    for (const resource of resources) resource.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const exporter = createWorkbookExporter({
    connection: database.connection,
    disk,
    path,
    ...options,
  });
  const enqueue = (id = 'synthetic-attempt', format = 'free') =>
    exporter.enqueue({
      attemptId: id,
      format,
      content: reportSheetData(report(id), format, format === 'amc8' ? 2026 : null),
    });
  return { directory, filename, database, disk, exporter, enqueue, open };
}

async function readWorkbook(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

test('AMC workbook has exactly 25 ordinal rows, numeric seconds, literal text, and a durable marker', async () => {
  const content = reportSheetData(report(), 'amc8', 2026);
  const job = {
    attempt_id: 'synthetic-attempt',
    format: 'amc8',
    book_id: 'synthetic-book',
    marker: '12345678-marker',
    payload: JSON.stringify(content),
    created_at: 1000,
  };
  const output = await appendResultWorksheet(null, job);
  const workbook = await readWorkbook(output.bytes),
    sheet = workbook.getWorksheet(output.name);
  assert.equal(sheet.rowCount - content.header, 25);
  assert.equal(sheet.getCell(content.header + 1, 2).value, '=1+1');
  assert.equal(sheet.getCell(content.header + 1, 2).type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell(content.header + 1, 3).value, 1.234);
  assert.equal(sheet.getCell(content.header + 1, 3).numFmt, '0.0');
  assert.equal(sheet.getCell('B6').value, 4.567);
  assert.equal(sheet.getCell('B6').numFmt, '0.0');
  assert.equal(sheet.getCell(content.header + 2, 4).value, 'Не решено');
  assert.equal(sheet.getCell(content.header + 3, 4).value, 'Нет в подборке');
  assert.equal(sheet.getCell(content.header + 25, 1).value, 25);
  assert.equal(workbook.getWorksheet('_TaskBattle').state, 'veryHidden');
  assert.equal(
    await verifyWorkbookMarker(output.bytes, job.book_id, job.marker, sha256(job.payload)),
    output.name,
  );
  assert.equal(output.name.length <= 31, true);
});

test('free export contains only accepted answers and preserves ordinary unrelated worksheet data and formatting', async () => {
  const content = reportSheetData(report(), 'free', null);
  assert.equal(content.values.length - content.header, 2);
  const first = {
    attempt_id: 'first',
    format: 'free',
    book_id: 'owned',
    marker: 'first-1234',
    payload: JSON.stringify(content),
    created_at: 1000,
  };
  const initial = await appendResultWorksheet(null, first);
  const workbook = await readWorkbook(initial.bytes),
    foreign = workbook.addWorksheet('Заметки преподавателя');
  foreign.getCell('B2').value = { formula: '1+1', result: 2 };
  foreign.getCell('B2').font = { name: 'Arial', bold: true, color: { argb: 'FF1200AB' } };
  foreign.getColumn(2).width = 47;
  const original = Buffer.from(await workbook.xlsx.writeBuffer());
  const next = await appendResultWorksheet(original, {
    ...first,
    attempt_id: 'second',
    marker: 'second-1234',
  });
  const saved = await readWorkbook(next.bytes),
    preserved = saved.getWorksheet('Заметки преподавателя');
  assert.deepEqual(preserved.getCell('B2').value, { formula: '1+1', result: 2 });
  assert.deepEqual(preserved.getCell('B2').font, foreign.getCell('B2').font);
  assert.equal(preserved.getColumn(2).width, 47);
  assert.equal(saved.getWorksheet(initial.name).getCell(content.header + 1, 2).value, '=1+1');
  assert.equal(saved.worksheets.length, 4);
  const duplicate = await appendResultWorksheet(next.bytes, {
    ...first,
    attempt_id: 'second',
    marker: 'second-1234',
  });
  assert.deepEqual(duplicate.bytes, next.bytes);
});

test('double click and different concurrent formats append once each to the same workbook', async (t) => {
  const { disk, exporter, enqueue, database } = fixture(t);
  const free = enqueue(),
    duplicate = enqueue(),
    amc = enqueue('synthetic-attempt', 'amc8');
  assert.equal(free.id, duplicate.id);
  const results = await Promise.all([
    exporter.process(free.id),
    exporter.process(duplicate.id),
    exporter.process(amc.id),
  ]);
  assert.equal(results[0].worksheet, results[1].worksheet);
  assert.equal(results[0].url, results[2].url);
  assert.equal(disk.uploads, 2);
  assert.equal((await readWorkbook(disk.bytes)).worksheets.length, 3);
  assert.equal(
    database.connection
      .prepare(
        "SELECT count(*) n FROM yandex_export_jobs WHERE status='complete' AND payload_bytes IS NULL",
      )
      .get().n,
    2,
  );
});

test('lost PUT acknowledgement is verified by remote bytes and marker without a duplicate upload', async (t) => {
  const { disk, exporter, enqueue } = fixture(t);
  disk.mode = 'lost-ack';
  const job = enqueue();
  const saved = await exporter.process(job.id);
  assert.ok(saved.worksheet);
  assert.deepEqual(await exporter.process(job.id), saved);
  assert.equal(disk.uploads, 1);
});

test('ambiguous PUT survives restart and blocks later work until its late write is confirmed', async (t) => {
  const f = fixture(t);
  const first = f.enqueue('first'),
    later = f.enqueue('later');
  f.disk.mode = 'late';
  await assert.rejects(f.exporter.process(first.id), { code: 'export-ambiguous' });
  const row = f.database.connection
    .prepare('SELECT status,payload_bytes,payload_hash FROM yandex_export_jobs WHERE id=?')
    .get(first.id);
  assert.equal(row.status, 'ambiguous');
  assert.equal(sha256(row.payload_bytes), row.payload_hash);
  f.database.close();
  const restarted = createWorkbookExporter({ connection: f.open().connection, disk: f.disk, path });
  await assert.rejects(restarted.process(first.id), { code: 'export-ambiguous' });
  await assert.rejects(restarted.process(later.id), { code: 'export-ambiguous' });
  assert.equal(f.disk.uploads, 1);
  f.disk.bytes = f.disk.pending;
  f.disk.pending = null;
  await restarted.process(later.id);
  assert.equal(f.disk.uploads, 2);
  assert.equal((await readWorkbook(f.disk.bytes)).worksheets.length, 3);
  await restarted.process(first.id);
  assert.equal(f.disk.uploads, 2);
});

test('a definite rejected PUT may retry while a changed remote workbook is never overwritten', async (t) => {
  const f = fixture(t),
    job = f.enqueue();
  f.disk.mode = 'definite';
  await assert.rejects(f.exporter.process(job.id), { code: 'disk-upload' });
  assert.equal(
    f.database.connection.prepare('SELECT status FROM yandex_export_jobs WHERE id=?').get(job.id)
      .status,
    'retryable',
  );
  await f.exporter.process(job.id);
  assert.equal(f.disk.uploads, 2);
  const external = await readWorkbook(f.disk.bytes);
  external.addWorksheet('External').getCell('A1').value = 'Keep this';
  f.disk.bytes = Buffer.from(await external.xlsx.writeBuffer());
  const before = Buffer.from(f.disk.bytes);
  await assert.rejects(f.exporter.process(f.enqueue('next').id), { code: 'export-conflict' });
  assert.equal(f.disk.uploads, 2);
  assert.deepEqual(f.disk.bytes, before);
});

test('foreign workbook ownership and edits during preparation prevent PUT', async (t) => {
  const foreignCase = fixture(t),
    workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Foreign').getCell('A1').value = 'Untouched';
  foreignCase.disk.bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const before = Buffer.from(foreignCase.disk.bytes);
  await assert.rejects(foreignCase.exporter.process(foreignCase.enqueue().id), {
    code: 'export-owner',
  });
  assert.equal(foreignCase.disk.uploads, 0);
  assert.deepEqual(foreignCase.disk.bytes, before);
  const changed = fixture(t);
  changed.disk.hook = () => {
    changed.disk.bytes = before;
  };
  await assert.rejects(changed.exporter.process(changed.enqueue().id), { code: 'export-conflict' });
  assert.equal(changed.disk.uploads, 0);
});

test('expired preparation lease cannot overwrite a newer worker result', async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now });
  const job = f.enqueue();
  let unblock, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.disk.hook = async () => {
    entered();
    await new Promise((resolve) => {
      unblock = resolve;
    });
  };
  const original = f.exporter.process(job.id);
  await ready;
  now += 120001;
  f.disk.hook = null;
  const replacement = createWorkbookExporter({
    connection: f.open().connection,
    disk: f.disk,
    path,
    now: () => now,
  });
  await replacement.process(job.id);
  unblock();
  await assert.rejects(original, (error) =>
    ['export-conflict', 'export-busy'].includes(error.code),
  );
  assert.equal(f.disk.uploads, 1);
});

test('export receipt remains after attempt deletion and more than 72 hours', async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now });
  f.database.connection.exec(
    "INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count) VALUES('room','request','Synthetic','hash',1,2,1); INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at) VALUES('synthetic-attempt','room','hash','[]',1,1);",
  );
  const job = f.enqueue();
  const result = await f.exporter.process(job.id);
  f.database.connection.exec(
    "DELETE FROM attempts WHERE id='synthetic-attempt'; DELETE FROM rooms WHERE id='room';",
  );
  now += 259200001;
  assert.deepEqual(await f.exporter.process(job.id), result);
  assert.equal(f.disk.uploads, 1);
  assert.equal(
    f.database.connection
      .prepare('SELECT count(*) n FROM yandex_export_jobs WHERE id=?')
      .get(job.id).n,
    1,
  );
});

test('Disk transport confines OAuth to API host, follows safe GET redirects, and never retries PUT', async () => {
  const calls = [],
    bytes = Buffer.from('synthetic workbook bytes');
  const client = createYandexDiskClient({
    tokenProvider: async () => 'synthetic-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/resources/download?'))
        return Response.json({
          href: 'https://downloader.disk.yandex.ru/first',
          method: 'GET',
          templated: false,
        });
      if (String(url).includes('/resources/upload?'))
        return Response.json({
          href: 'https://uploader-test.disk.yandex.net/upload',
          method: 'PUT',
          templated: false,
        });
      if (String(url).includes('/resources?'))
        return Response.json({ type: 'file', size: bytes.length, sha256: sha256(bytes) });
      if (String(url).endsWith('/first'))
        return new Response(null, {
          status: 302,
          headers: { location: 'https://downloader.disk.yandex.ru/final' },
        });
      if (options.method === 'PUT') return new Response(null, { status: 201 });
      return new Response(bytes);
    },
  });
  assert.equal((await client.stat(path)).sha256, sha256(bytes));
  assert.deepEqual(await client.download(path), bytes);
  await (
    await client.prepareUpload(path, true)
  )(bytes);
  const apiCalls = calls.filter((call) => new URL(call.url).hostname === 'cloud-api.yandex.net');
  assert.equal(apiCalls.length, 3);
  for (const call of apiCalls)
    assert.equal(call.options.headers.Authorization, 'OAuth synthetic-token');
  for (const call of calls.filter((call) => !apiCalls.includes(call)))
    assert.equal(call.options.headers?.Authorization, undefined);
  assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1);
  assert.ok(calls.every((call) => call.options.redirect === 'manual'));
});

test('Disk transport blocks unsafe URLs, oversize downloads and expired authorization without exposing response bodies', async () => {
  for (const value of [
    'http://downloader.disk.yandex.ru/file',
    'https://disk.yandex.ru.attacker.invalid/file',
    'https://127.0.0.1/file',
    'https://user:pass@downloader.disk.yandex.ru/file',
  ])
    assert.throws(() => validateTransferUrl(value), { code: 'disk-link' });
  assert.throws(() => validateDiskPath('disk:/../file.xlsx'), { code: 'disk-setup' });
  assert.equal(
    diskWebUrl(path),
    'https://disk.yandex.ru/client/disk/%D0%A0%D0%B5%D0%B7%D1%83%D0%BB%D1%8C%D1%82%D0%B0%D1%82%D1%8B%20TASKBATTLE.xlsx',
  );
  const auth = createYandexDiskClient({
    tokenProvider: () => 'synthetic-token',
    fetchImpl: async () => new Response('sensitive provider details', { status: 401 }),
  });
  await assert.rejects(
    auth.stat(path),
    (error) => error.code === 'disk-auth' && !error.message.includes('sensitive'),
  );
  const unsafe = createYandexDiskClient({
    tokenProvider: () => 'synthetic-token',
    fetchImpl: async (url) =>
      String(url).startsWith('https://cloud-api.')
        ? Response.json({
            href: 'https://downloader.disk.yandex.ru/file',
            method: 'GET',
            templated: false,
          })
        : new Response(null, {
            status: 302,
            headers: { location: 'https://attacker.invalid/file' },
          }),
  });
  await assert.rejects(unsafe.download(path), { code: 'disk-link' });
  const oversized = createYandexDiskClient({
    tokenProvider: () => 'synthetic-token',
    maxBytes: 10,
    fetchImpl: async (url) =>
      String(url).startsWith('https://cloud-api.')
        ? Response.json({
            href: 'https://downloader.disk.yandex.ru/file',
            method: 'GET',
            templated: false,
          })
        : new Response(new Uint8Array(11)),
  });
  await assert.rejects(oversized.download(path), { code: 'disk-size' });
});

test('Disk PUT 5xx is ambiguous and does not trigger a second transfer or a redirect', async () => {
  for (const status of [503, 307]) {
    let transfers = 0;
    const client = createYandexDiskClient({
      tokenProvider: () => 'synthetic-token',
      fetchImpl: async (_url, options) => {
        if (options.method !== 'PUT')
          return Response.json({
            href: 'https://uploader-test.disk.yandex.net/upload',
            method: 'PUT',
            templated: false,
          });
        transfers++;
        return new Response(null, {
          status,
          headers: { location: 'https://uploader-test.disk.yandex.net/redirect' },
        });
      },
    });
    await assert.rejects(
      (await client.prepareUpload(path, false))(Buffer.from('synthetic')),
      (error) => error.code === 'disk-upload' && error.ambiguous === true,
    );
    assert.equal(transfers, 1);
  }
});

test('explicit 0006 adoption applies only new export migration and preserves imported row timestamps', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'taskbattle-prefix-test-'));
  const filename = join(directory, 'imported.sqlite'),
    connection = new DatabaseSync(filename);
  t.after(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const migrations = readMigrationFiles();
  for (const migration of migrations.filter((item) => item.id <= 6)) connection.exec(migration.sql);
  connection.exec(
    "INSERT INTO rooms(id,request_id,title,teacher_hash,created_at,expires_at,count) VALUES('room','request','Synthetic','hash',1,9000000000000,1); INSERT INTO attempts(id,room_id,secret_hash,order_json,started_at,task_started_at,deadline_at) VALUES('attempt','room','hash','[]',2,3,NULL);",
  );
  const result = migrateDatabase(filename, { adoptExisting: true, adoptThrough: 6 });
  assert.equal(result.adopted, 7);
  assert.equal(result.applied, migrations.length - 7);
  assert.equal(connection.prepare('SELECT expires_at FROM rooms').get().expires_at, 9000000000000);
  assert.equal(connection.prepare('SELECT deadline_at FROM attempts').get().deadline_at, null);
  assert.equal(
    connection.prepare(`SELECT adopted FROM ${MIGRATION_TABLE} WHERE id=7`).get().adopted,
    0,
  );
  assert.equal(connection.prepare('SELECT count(*) n FROM yandex_export_jobs').get().n, 0);
  assert.throws(() => migrateDatabase(filename, { adoptThrough: 6 }), /explicit adoption/);
});
