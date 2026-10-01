import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat, open, chmod, link } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { metadataToken, objectStore } from './yandex.mjs';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refs = (connection) =>
  connection
    .prepare(
      'SELECT file_key AS key FROM tasks UNION SELECT solution_key AS key FROM answers WHERE solution_key IS NOT NULL',
    )
    .all()
    .map((row) => row.key);
export async function createBackup(filename, scratch, source, destination) {
  await mkdir(dirname(scratch), { recursive: true, mode: 0o700 });
  await (await open(scratch, 'wx', 0o600)).close();
  try {
    const connection = new DatabaseSync(filename, { readOnly: true });
    try {
      await backup(connection, scratch);
      await chmod(scratch, 0o600);
    } finally {
      connection.close();
    }
    const snapshot = new DatabaseSync(scratch, { readOnly: true });
    let keys;
    try {
      if (
        snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        snapshot.prepare('PRAGMA foreign_key_check').all().length
      )
        throw new Error('Backup database is not consistent');
      keys = refs(snapshot);
    } finally {
      snapshot.close();
    }
    const manifest = {
      format: 'taskbattle-backup',
      version: 1,
      createdAt: Date.now(),
      database: null,
      objects: [],
    };
    for (const key of keys) {
      const file = await source.get(key);
      if (!file) throw new Error('Referenced backup object is missing; retry after cleanup');
      const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
      const hash = digest(bytes),
        backupKey = 'objects/' + hash;
      // Refresh Last-Modified. Objects retain 9 days, manifests 7 days; the job is
      // bounded to <24h so dependencies cannot expire before their manifest.
      await destination.put(backupKey, bytes);
      manifest.objects.push({ key, backupKey, sha256: hash, bytes: bytes.length });
    }
    const bytes = await readFile(scratch),
      prefix = `snapshots/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    manifest.database = {
      key: 'objects/' + digest(bytes),
      sha256: digest(bytes),
      bytes: bytes.length,
    };
    await destination.put(manifest.database.key, bytes);
    // Manifest last is the commit marker. An incomplete backup is never a restore candidate.
    await destination.put(
      prefix + '/manifest.json',
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    return { manifestKey: prefix + '/manifest.json', objects: keys.length };
  } finally {
    for (const suffix of ['', '-wal', '-shm'])
      await unlink(scratch + suffix).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
  }
}
export async function restoreBackup(manifestKey, targetFile, source, target) {
  try {
    await stat(targetFile);
    throw new Error('Restore refuses to replace a database');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const item = await source.get(manifestKey);
  if (!item) throw new Error('Backup manifest not found');
  const manifest = await new Response(item.body).json();
  if (
    manifest.format !== 'taskbattle-backup' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.objects)
  )
    throw new Error('Invalid backup manifest');
  async function verified(key, hash, length) {
    const object = await source.get(key);
    if (!object) throw new Error('Backup object not found');
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (bytes.length !== length || digest(bytes) !== hash)
      throw new Error('Backup checksum mismatch');
    return bytes;
  }
  const bytes = await verified(
    manifest.database.key,
    manifest.database.sha256,
    manifest.database.bytes,
  );
  await mkdir(dirname(targetFile), { recursive: true, mode: 0o700 });
  const staging = targetFile + '.restoring-' + randomUUID();
  await writeFile(staging, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const connection = new DatabaseSync(staging);
    try {
      if (
        connection.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        connection.prepare('PRAGMA foreign_key_check').all().length
      )
        throw new Error('Restore integrity check failed');
      const required = new Set(refs(connection));
      if (
        required.size !== manifest.objects.length ||
        manifest.objects.some((o) => !required.delete(o.key))
      )
        throw new Error('Restore references differ from manifest');
      for (const object of manifest.objects) {
        const contents = await verified(object.backupKey, object.sha256, object.bytes);
        const existing = await target.get(object.key);
        if (existing) {
          if (
            digest(new Uint8Array(await new Response(existing.body).arrayBuffer())) !==
            object.sha256
          )
            throw new Error('Restore refuses to replace a different object');
        } else await target.put(object.key, contents);
      }
      // Restores start frozen. Deadlines are original; only explicit activation can serve them.
      connection
        .prepare('UPDATE migration_gate SET frozen=1,frozen_at=?,updated_at=? WHERE singleton=1')
        .run(Date.now(), Date.now());
    } finally {
      connection.close();
    }
    // Same-volume hard link publishes the complete file atomically, without replacement.
    await link(staging, targetFile);
    return { objects: manifest.objects.length, frozen: true };
  } finally {
    for (const suffix of ['', '-wal', '-shm'])
      await unlink(staging + suffix).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const token = metadataToken();
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await createBackup(
          process.env.DB_PATH,
          resolve(
            process.env.BACKUP_SCRATCH_DIR || '/var/lib/taskbattle/backups',
            randomUUID() + '.sqlite',
          ),
          objectStore(process.env.YANDEX_BUCKET, token),
          objectStore(process.env.YANDEX_BACKUP_BUCKET, token),
        );
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    console.log(JSON.stringify({ event: 'backup-complete', ...result }));
  } catch {
    console.error(JSON.stringify({ event: 'backup-failed' }));
    process.exitCode = 1;
  }
}
