import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const statementState = new WeakMap();

// SQLite's WAL-reset fix shipped in these branches. Separate connections are
// used by backups/maintenance, so older affected builds must fail at startup.
export function isSafeWalVersion(version) {
  const parts = String(version).split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0))
    return false;
  const [major, minor, patch] = parts;
  return (
    major > 3 ||
    (major === 3 &&
      (minor > 51 ||
        (minor === 51 && patch >= 3) ||
        (minor === 50 && patch >= 7) ||
        (minor === 44 && patch >= 6)))
  );
}

function databasePath(filename, allowMemoryForTests) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.trim() !== filename)
    throw new TypeError('A non-empty SQLite file path is required.');
  if (filename === ':memory:') {
    if (allowMemoryForTests === true) return filename;
    throw new Error('In-memory SQLite is disabled; configure a persistent database file.');
  }
  if (/^file:/i.test(filename) || /(^|[\\/]):memory:$/i.test(filename))
    throw new Error('SQLite URI and in-memory paths are not supported.');
  return resolve(filename);
}

function bindValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('SQLite bindings must be strings, finite numbers, bigint, bytes, or null.');
}

function firstKeyword(query) {
  return query.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').match(/^[a-z]+/i)?.[0];
}

function safeNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError('SQLite metadata exceeds a safe integer.');
  return number;
}

class SqliteStatement {
  constructor(owner, query, args = []) {
    statementState.set(this, { owner, query, args });
  }

  bind(...args) {
    const { owner, query } = statementState.get(this);
    return new SqliteStatement(owner, query, args.map(bindValue));
  }

  async first(column) {
    const { results } = statementState.get(this).owner.execute(this, 'all');
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!Object.hasOwn(row, column))
      throw new Error('The requested SQLite result column is absent.');
    return row[column];
  }

  async all() {
    return statementState.get(this).owner.execute(this, 'all');
  }

  async run() {
    return statementState.get(this).owner.execute(this, 'run');
  }
}

/** The D1 subset used by TaskBattle, backed by a persistent, synchronous SQLite connection. */
export class SqliteDatabase {
  #closed = false;

  constructor(filename, { allowMemoryForTests = false, busyTimeoutMs = 5000 } = {}) {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60000)
      throw new RangeError('SQLite busy timeout must be an integer between 1 and 60000 ms.');
    this.filename = databasePath(filename, allowMemoryForTests);
    this.connection = new DatabaseSync(this.filename, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      const version = this.connection.prepare('SELECT sqlite_version() AS version').get().version;
      if (!isSafeWalVersion(version))
        throw new Error(
          'SQLite with the WAL-reset fix is required (3.51.3+, 3.50.7+, or 3.44.6+).',
        );
      this.connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.connection.exec('PRAGMA foreign_keys = ON');
      const journal = this.connection.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
      if (journal !== 'wal' && this.filename !== ':memory:')
        throw new Error('SQLite could not enable WAL for the persistent database.');
      this.connection.exec('PRAGMA synchronous = FULL');
    } catch (error) {
      this.connection.close();
      this.#closed = true;
      throw error;
    }
  }

  prepare(query) {
    this.#assertOpen();
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('A SQL query is required.');
    // A statement cannot escape a batch transaction. Internal migration code
    // uses the underlying connection explicitly for transaction boundaries.
    if (
      /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH)$/i.test(
        firstKeyword(query) || '',
      )
    )
      throw new Error('Transaction and attachment statements are not supported by this adapter.');
    return new SqliteStatement(this, query);
  }

  execute(statement, mode) {
    this.#assertOpen();
    const state = statementState.get(statement);
    if (state?.owner !== this)
      throw new TypeError('The SQLite statement belongs to another database.');
    const prepared = this.connection.prepare(state.query);
    if (mode === 'run') {
      const result = prepared.run(...state.args);
      return {
        success: true,
        results: [],
        meta: {
          changes: safeNumber(result.changes),
          last_row_id: safeNumber(result.lastInsertRowid),
        },
      };
    }
    const before = this.connection.prepare('SELECT total_changes() AS count').get().count;
    // Exhaust RETURNING statements before returning control or committing a batch.
    const results = prepared.all(...state.args).map((row) => ({ ...row }));
    const counters = this.connection
      .prepare(
        'SELECT total_changes() AS count, changes() AS changes, last_insert_rowid() AS rowid',
      )
      .get();
    return {
      success: true,
      results,
      meta: {
        changes: counters.count === before ? 0 : safeNumber(counters.changes),
        last_row_id: safeNumber(counters.rowid),
      },
    };
  }

  async batch(statements) {
    this.#assertOpen();
    if (!Array.isArray(statements))
      throw new TypeError('SQLite batch expects an array of statements.');
    for (const statement of statements)
      if (statementState.get(statement)?.owner !== this)
        throw new TypeError('Every batch statement must belong to this SQLite database.');
    if (statements.length === 0) return [];
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      // Do not add await here: no other request may use this connection between
      // BEGIN and COMMIT, including when a statement returns rows.
      const results = statements.map((statement) => this.execute(statement, 'all'));
      this.connection.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.connection.isTransaction) this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    if (!this.#closed) {
      this.connection.close();
      this.#closed = true;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new Error('The SQLite database is closed.');
  }
}

export function openSqliteDatabase(filename, options) {
  return new SqliteDatabase(filename, options);
}
