import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openSqliteDatabase } from './sqlite.mjs';
import { metadataToken, lockboxSecrets, objectStore } from './yandex.mjs';

export async function initialize({ database = true } = {}) {
  const config = process.env;
  const origin = new URL(config.APP_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.origin !== config.APP_ORIGIN)
    throw new Error('APP_ORIGIN must be a canonical HTTPS origin');
  const token = metadataToken();
  const secrets = config.YANDEX_LOCKBOX_SECRET_ID
    ? await lockboxSecrets(config.YANDEX_LOCKBOX_SECRET_ID, token)
    : {};
  const cleanup = secrets.CLEANUP_SECRET || config.CLEANUP_SECRET;
  if (!/^[a-f0-9]{64}$/.test(cleanup || ''))
    throw new Error('Configure CLEANUP_SECRET in Lockbox before starting');
  const env = {
    RUNTIME: 'yandex',
    APP_ORIGIN: config.APP_ORIGIN,
    CLEANUP_SECRET: cleanup,
    MIGRATION_SECRET: secrets.MIGRATION_SECRET || config.MIGRATION_SECRET,
    MIGRATION_DRAIN: config.MIGRATION_DRAIN,
  };
  Object.defineProperty(env, 'MAINTENANCE', {
    get: () => existsSync(config.MAINTENANCE_FILE || '/var/lib/taskbattle/maintenance'),
  });
  globalThis.__taskbattleExportConfig = {
    ...secrets,
    YANDEX_DISK_PATH: config.YANDEX_DISK_PATH,
    APP_ORIGIN: config.APP_ORIGIN,
  };
  if (database) {
    if (!isAbsolute(config.DB_PATH || '') || !existsSync(config.DB_PATH))
      throw new Error('DB_PATH must point to an existing migrated database on persistent disk');
    env.DB = openSqliteDatabase(config.DB_PATH);
    env.BUCKET = objectStore(config.YANDEX_BUCKET, token);
  }
  globalThis.__taskbattleRuntime = env;
  return { env, token, secrets };
}
