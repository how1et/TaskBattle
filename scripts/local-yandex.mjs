// Local verification only. Production start.mjs always uses private Yandex Object Storage.
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { startProdServer } from 'vinext/server/prod-server';
import { migrateDatabase } from '../runtime/migrate.mjs';
import { openSqliteDatabase } from '../runtime/sqlite.mjs';
const base = resolve('var/local-yandex'),
  objectRoot = resolve(base, 'objects');
await mkdir(base, { recursive: true });
const filename = resolve(base, 'taskbattle.sqlite');
migrateDatabase(filename);
function objectPath(key) {
  const file = resolve(objectRoot, key);
  if (!file.startsWith(objectRoot + sep)) throw Error('Unsafe fixture object key');
  return file;
}
const env = {
  RUNTIME: 'yandex',
  APP_ORIGIN: 'http://127.0.0.1:3000',
  CLEANUP_SECRET: '0'.repeat(64),
  DB: openSqliteDatabase(filename),
  BUCKET: {
    async put(key, value) {
      const file = objectPath(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, new Uint8Array(await new Response(value).arrayBuffer()));
    },
    async get(key) {
      try {
        return { body: await readFile(objectPath(key)) };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys])
        await unlink(objectPath(key)).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
    },
  },
};
globalThis.__taskbattleRuntime = env;
globalThis.__taskbattleExportConfig = {};
const { server } = await startProdServer({
  host: '127.0.0.1',
  port: 3000,
  outDir: resolve('dist-yandex'),
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      env.DB.close();
      process.exit(0);
    }),
  );
