import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteDatabase } from './sqlite.mjs';

export const MIGRATION_TABLE = '__taskbattle_migrations';
export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../drizzle/', import.meta.url));
const providerTables = new Set(['d1_migrations', '__drizzle_migrations', '_cf_KV']);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export function readMigrationFiles(directory = DEFAULT_MIGRATIONS_DIRECTORY) {
  const names = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  if (names.length === 0) throw new Error('No SQLite migration files were found.');
  return names.map((name, index) => {
    if (Number(name.slice(0, 4)) !== index)
      throw new Error('SQLite migrations must have unique consecutive numbers starting at 0000.');
    const sql = readFileSync(join(directory, name), 'utf8');
    if (!sql.trim()) throw new Error(`The SQLite migration ${name} is empty.`);
    return {
      id: index,
      name,
      sql,
      // Git line-ending conversion does not change a migration's identity.
      checksum: createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex'),
    };
  });
}

function normalizedSql(sql) {
  if (!sql) return null;
  // Preserve string literals, but normalize SQLite's equivalent identifier
  // quoting and spacing (a D1 export may add IF NOT EXISTS or change quoting).
  const tokens =
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[a-zA-Z_][a-zA-Z_0-9]*|[^\s]/g,
    ) || [];
  const normalized = tokens
    .filter((token) => !token.startsWith('--') && !token.startsWith('/*') && token !== ';')
    .map((token) => {
      if (token.startsWith("'")) return token;
      if (token.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"').toLowerCase();
      if (token.startsWith('`')) return token.slice(1, -1).replaceAll('``', '`').toLowerCase();
      if (token.startsWith('[')) return token.slice(1, -1).toLowerCase();
      return token.toLowerCase();
    });
  return normalized
    .filter(
      (_, index) =>
        ![index, index - 1, index - 2].some(
          (start) =>
            normalized[start] === 'if' &&
            normalized[start + 1] === 'not' &&
            normalized[start + 2] === 'exists',
        ),
    )
    .join(' ');
}

/** Schema-only inspection: never reads or returns application row contents. */
export function getSchemaSnapshot(connection) {
  const ignored = (name) => name === MIGRATION_TABLE || providerTables.has(name);
  const objects = connection
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()
    .filter((item) => !ignored(item.name) && !(item.type === 'index' && ignored(item.tbl_name)));
  const tableOptions = connection.prepare('PRAGMA table_list').all();
  return {
    tables: objects
      .filter((item) => item.type === 'table')
      .map((table) => {
        const options = tableOptions.find(
          (item) => item.schema === 'main' && item.name === table.name,
        );
        return {
          name: table.name,
          sql: normalizedSql(table.sql),
          strict: options?.strict,
          withoutRowid: options?.wr,
          columns: connection
            .prepare(`PRAGMA table_xinfo(${quote(table.name)})`)
            .all()
            .map((row) => ({ ...row })),
          foreignKeys: connection
            .prepare(`PRAGMA foreign_key_list(${quote(table.name)})`)
            .all()
            .map((row) => ({ ...row })),
          indexes: connection
            .prepare(`PRAGMA index_list(${quote(table.name)})`)
            .all()
            .map((index) => ({
              name: index.name,
              unique: index.unique,
              origin: index.origin,
              partial: index.partial,
              columns: connection
                .prepare(`PRAGMA index_xinfo(${quote(index.name)})`)
                .all()
                .map((row) => ({ ...row })),
              sql: normalizedSql(
                objects.find((item) => item.type === 'index' && item.name === index.name)?.sql,
              ),
            }))
            .sort((left, right) => left.name.localeCompare(right.name, 'en')),
        };
      }),
    other: objects
      .filter((item) => !['table', 'index'].includes(item.type))
      .map((item) => ({
        type: item.type,
        name: item.name,
        table: item.tbl_name,
        sql: normalizedSql(item.sql),
      })),
  };
}

function referenceSchema(migrations) {
  const directory = mkdtempSync(join(tmpdir(), 'taskbattle-schema-'));
  let reference;
  try {
    reference = openSqliteDatabase(join(directory, 'reference.sqlite'));
    reference.connection.exec('BEGIN IMMEDIATE');
    for (const migration of migrations) reference.connection.exec(migration.sql);
    reference.connection.exec('COMMIT');
    return getSchemaSnapshot(reference.connection);
  } finally {
    reference?.close();
    // This directory is created above and contains only our empty reference DB.
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertSchema(connection, expected) {
  if (JSON.stringify(getSchemaSnapshot(connection)) !== JSON.stringify(expected))
    throw new Error(
      'SQLite schema does not match the migration files; no migration journal was adopted.',
    );
}

function assertIntegrity(connection) {
  const checks = connection.prepare('PRAGMA quick_check').all();
  if (checks.length !== 1 || checks[0].quick_check !== 'ok')
    throw new Error('SQLite integrity verification failed.');
  if (connection.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('SQLite contains foreign-key violations; repair the import before adoption.');
}

function createJournal(connection) {
  connection.exec(`CREATE TABLE ${quote(MIGRATION_TABLE)} (
    id INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    adopted INTEGER NOT NULL CHECK (adopted IN (0, 1))
  )`);
}

function recordMigration(connection, migration, adopted) {
  connection
    .prepare(
      `INSERT INTO ${quote(MIGRATION_TABLE)} (id,name,checksum,applied_at,adopted) VALUES (?,?,?,?,?)`,
    )
    .run(migration.id, migration.name, migration.checksum, Date.now(), adopted ? 1 : 0);
}

/**
 * Initialize an empty file or apply pending journaled migrations. A database
 * imported from D1 must be explicitly adopted at the complete current schema;
 * adoption records checksums without executing historical backfills.
 */
export function migrateDatabase(
  filename,
  { adoptExisting = false, adoptThrough, migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY } = {},
) {
  const migrations = readMigrationFiles(migrationsDirectory);
  if (
    adoptThrough !== undefined &&
    (!adoptExisting ||
      !Number.isSafeInteger(adoptThrough) ||
      adoptThrough < 0 ||
      adoptThrough >= migrations.length)
  )
    throw new Error('adoptThrough requires explicit adoption and a known migration number.');
  if (adoptExisting && !existsSync(filename))
    throw new Error('Adoption requires an existing SQLite database file.');
  const database = openSqliteDatabase(filename);
  const connection = database.connection;
  try {
    connection.exec('BEGIN IMMEDIATE');
    const journalExists = Boolean(
      connection
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
        .get(MIGRATION_TABLE),
    );
    const snapshot = getSchemaSnapshot(connection);
    const hasSchema = snapshot.tables.length > 0 || snapshot.other.length > 0;
    if (!journalExists && hasSchema) {
      if (!adoptExisting)
        throw new Error(
          'An existing unjournaled database requires explicit --adopt-existing after a verified import.',
        );
      const adoptedMigrations = migrations.slice(0, (adoptThrough ?? migrations.length - 1) + 1);
      assertSchema(connection, referenceSchema(adoptedMigrations));
      assertIntegrity(connection);
      createJournal(connection);
      for (const migration of adoptedMigrations) recordMigration(connection, migration, true);
      const pending = migrations.slice(adoptedMigrations.length);
      for (const migration of pending) {
        connection.exec(migration.sql);
        recordMigration(connection, migration, false);
      }
      assertIntegrity(connection);
      connection.exec('COMMIT');
      return {
        status: 'adopted',
        applied: pending.length,
        adopted: adoptedMigrations.length,
        total: migrations.length,
      };
    }
    if (adoptExisting && !hasSchema)
      throw new Error('Cannot adopt an empty database; initialize it without --adopt-existing.');
    if (!journalExists) createJournal(connection);
    const applied = connection
      .prepare(
        `SELECT id,name,checksum,applied_at,adopted FROM ${quote(MIGRATION_TABLE)} ORDER BY id`,
      )
      .all();
    if (applied.length > migrations.length)
      throw new Error('The SQLite database has migrations unknown to this release.');
    for (let index = 0; index < applied.length; index++) {
      const entry = applied[index],
        expected = migrations[index];
      if (
        entry.id !== expected.id ||
        entry.name !== expected.name ||
        entry.checksum !== expected.checksum ||
        !Number.isSafeInteger(entry.applied_at) ||
        ![0, 1].includes(entry.adopted)
      )
        throw new Error('The SQLite migration journal does not match this release.');
    }
    // Refuse partial imports or manual schema changes even when a journal exists.
    if (journalExists)
      assertSchema(connection, referenceSchema(migrations.slice(0, applied.length)));
    const pending = migrations.slice(applied.length);
    for (const migration of pending) {
      connection.exec(migration.sql);
      recordMigration(connection, migration, false);
    }
    assertIntegrity(connection);
    connection.exec('COMMIT');
    return {
      status: pending.length ? 'migrated' : 'up-to-date',
      applied: pending.length,
      adopted: 0,
      total: migrations.length,
    };
  } catch (error) {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

export function runMigrationCli(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      'Usage: node runtime/migrate.mjs --database <persistent-file> [--adopt-existing [--adopt-through <number>]]',
    );
    return;
  }
  let filename;
  let adoptExisting = false;
  let adoptThrough;
  for (let index = 0; index < args.length; index++) {
    if (
      args[index] === '--database' &&
      filename === undefined &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      filename = args[++index];
    else if (args[index] === '--adopt-existing' && !adoptExisting) adoptExisting = true;
    else if (
      args[index] === '--adopt-through' &&
      adoptThrough === undefined &&
      /^\d+$/.test(args[index + 1] || '')
    )
      adoptThrough = Number(args[++index]);
    else throw new Error('Invalid migration arguments. Use --help for the supported options.');
  }
  if (!filename) throw new Error('An explicit --database path is required.');
  console.log(JSON.stringify(migrateDatabase(filename, { adoptExisting, adoptThrough })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runMigrationCli();
  } catch (error) {
    console.error(`SQLite migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
