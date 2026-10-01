import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, stat, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySnapshot, TABLES } from './migration-transfer.mjs';
import { readMigrationFiles, migrateDatabase } from '../runtime/migrate.mjs';
import { digest } from '../runtime/backup.mjs';
import { metadataToken, objectStore } from '../runtime/yandex.mjs';

export async function restoreMigration(directory, filename, bucket) {
  const manifest = await verifySnapshot(directory);
  try {
    await stat(filename);
    throw new Error('Import requires a new database path');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await (await open(filename, 'wx', 0o600)).close();
  const db = new DatabaseSync(filename);
  try {
    for (const migration of readMigrationFiles().slice(0, manifest.schemaVersion + 1)) {
      // Read exact historical schema once for the NEW empty destination.
      db.exec(await readFile(new URL('../drizzle/' + migration.name, import.meta.url), 'utf8'));
    }
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
    try {
      for (const table of TABLES)
        for (const page of manifest.tables.filter((p) => p.table === table)) {
          const rows = JSON.parse(await readFile(resolve(directory, page.path), 'utf8'));
          const allowed = new Set(
            db
              .prepare(`PRAGMA table_info("${table}")`)
              .all()
              .map((c) => c.name),
          );
          for (const row of rows) {
            const names = Object.keys(row);
            if (names.some((n) => !allowed.has(n))) throw new Error('Unexpected imported column');
            db.prepare(
              `INSERT INTO "${table}" (${names.map((n) => '"' + n + '"').join(',')}) VALUES (${names.map(() => '?').join(',')})`,
            ).run(...names.map((n) => row[n]));
          }
        }
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('Imported references are inconsistent');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const object of manifest.objects) {
      const bytes = await readFile(resolve(directory, object.path));
      const old = await bucket.get(object.key);
      if (old) {
        if (digest(new Uint8Array(await new Response(old.body).arrayBuffer())) !== object.sha256)
          throw new Error('Object collision; refusing overwrite');
      } else await bucket.put(object.key, bytes);
      const check = await bucket.get(object.key);
      if (
        !check ||
        digest(new Uint8Array(await new Response(check.body).arrayBuffer())) !== object.sha256
      )
        throw new Error('Uploaded object verification failed');
    }
    for (const [table, count] of Object.entries(manifest.counts)) {
      if (
        !TABLES.includes(table) ||
        db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n !== count
      )
        throw new Error('Imported row counts differ');
    }
  } finally {
    // Also freeze incomplete imports so they cannot accidentally receive traffic.
    try {
      db.prepare(
        'UPDATE migration_gate SET frozen=1,frozen_at=?,updated_at=? WHERE singleton=1',
      ).run(manifest.frozenAt, Date.now());
    } finally {
      db.close();
    }
  }
  migrateDatabase(filename, { adoptExisting: true, adoptThrough: manifest.schemaVersion });
  return {
    rows: Object.values(manifest.counts).reduce((a, b) => a + b, 0),
    objects: manifest.objects.length,
    frozen: true,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [snapshot, target] = process.argv.slice(2);
    if (!snapshot || !target)
      throw new Error('Usage: node scripts/restore-migration.mjs SNAPSHOT_DIR NEW_DB_PATH');
    console.log(
      JSON.stringify(
        await restoreMigration(
          resolve(snapshot),
          resolve(target),
          objectStore(process.env.YANDEX_BUCKET, metadataToken()),
        ),
      ),
    );
  } catch {
    console.error('Migration restore failed; target remains unactivated.');
    process.exitCode = 1;
  }
}
