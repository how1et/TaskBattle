import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { metadataToken, objectStore, lockboxSecrets } from '../runtime/yandex.mjs';
import { createBackup, restoreBackup } from '../runtime/backup.mjs';
import { migrateDatabase } from '../runtime/migrate.mjs';

test('Yandex metadata token coalesces, refreshes; Lockbox returns only explicit server secrets', async () => {
  let n = 0;
  const token = metadataToken(async (_url, options) => {
    assert.equal(options.headers['Metadata-Flavor'], 'Google');
    n++;
    return Response.json({ access_token: 'fixture-' + n, expires_in: 3600 });
  });
  assert.deepEqual(await Promise.all([token(), token()]), ['fixture-1', 'fixture-1']);
  assert.equal(await token(true), 'fixture-2');
  const config = await lockboxSecrets('fixture', token, async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-2');
    return Response.json({
      entries: [
        { key: 'CLEANUP_SECRET', textValue: 'fixture' },
        { key: 'NODE_OPTIONS', textValue: 'unsafe' },
      ],
    });
  });
  assert.equal(config.CLEANUP_SECRET, 'fixture');
  assert.equal(config.NODE_OPTIONS, undefined);
});

test('private object adapter rejects path escapes, checksums PUT, renews 401 and keeps delete errors visible', async () => {
  const calls = [];
  let unauthorized = true;
  const store = objectStore('test-bucket', async (fresh) => (fresh ? 'renewed' : 'old'), {
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (unauthorized) {
        unauthorized = false;
        return new Response('', { status: 401 });
      }
      if (init.method === 'DELETE') return new Response('', { status: 503 });
      if (init.method === 'GET') return new Response('', { status: 404 });
      return new Response('', { status: 200 });
    },
  });
  await store.put('photos/test.png', new Uint8Array([1, 2]), {
    httpMetadata: { contentType: 'image/png' },
  });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer renewed');
  assert.ok(calls[1].init.headers['Content-MD5']);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(await store.get('missing'), null);
  await assert.rejects(store.get('../secret'));
  await assert.rejects(store.delete(['photos/test.png']));
  assert.throws(() =>
    objectStore('test-bucket', async () => '', { endpoint: 'https://attacker.example' }),
  );
});

function memoryStore() {
  const files = new Map();
  return {
    files,
    async put(key, bytes) {
      files.set(key, new Uint8Array(await new Response(bytes).arrayBuffer()));
    },
    async get(key) {
      return files.has(key) ? { body: files.get(key) } : null;
    },
  };
}
test('online backup and verified restore preserve original records, photos, deadlines and start frozen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbattle-backup-'));
  try {
    const filename = join(dir, 'source.sqlite');
    migrateDatabase(filename);
    const db = new DatabaseSync(filename);
    try {
      db.prepare(
        'INSERT INTO rooms(id,title,teacher_hash,created_at,expires_at,count,request_id) VALUES (?,?,?,?,?,?,?)',
      ).run('room', 'Fixture', 'hash', 100, 200, 1, 'fixture-request');
      db.prepare(
        'INSERT INTO tasks(id,room_id,ordinal,file_key,mime,answer) VALUES (?,?,?,?,?,?)',
      ).run('task', 'room', 1, 'photos/task', 'image/png', '5');
    } finally {
      db.close();
    }
    const source = memoryStore(),
      remote = memoryStore(),
      restoredObjects = memoryStore();
    await source.put('photos/task', new Uint8Array([4, 8, 15]));
    const result = await createBackup(filename, join(dir, 'scratch.sqlite'), source, remote);
    const restored = join(dir, 'restored.sqlite');
    await restoreBackup(result.manifestKey, restored, remote, restoredObjects);
    const check = new DatabaseSync(restored);
    assert.equal(check.prepare('SELECT expires_at FROM rooms').get().expires_at, 200);
    assert.equal(check.prepare('SELECT frozen FROM migration_gate').get().frozen, 1);
    check.close();
    assert.deepEqual(restoredObjects.files.get('photos/task'), new Uint8Array([4, 8, 15]));
    await assert.rejects(
      restoreBackup(result.manifestKey, restored, remote, restoredObjects),
      /refuses/,
    );
    const manifest = JSON.parse(new TextDecoder().decode(remote.files.get(result.manifestKey)));
    assert.match(manifest.database.key, /^objects\/[a-f0-9]{64}$/);
    assert.match(result.manifestKey, /^snapshots\//);
    remote.files.set(manifest.database.key, new Uint8Array([9]));
    await assert.rejects(
      restoreBackup(result.manifestKey, join(dir, 'corrupt.sqlite'), remote, restoredObjects),
      /checksum/,
    );
    assert.ok((await readFile(restored)).length);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
