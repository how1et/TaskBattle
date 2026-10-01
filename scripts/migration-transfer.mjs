import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLES = Object.freeze([
  'rooms',
  'tasks',
  'attempts',
  'answers',
  'attempt_intervals',
  'attempt_operations',
  'sheet_exports',
  'blobs',
  'expired_attempts',
  'rate_limits',
  'cancelled_answers',
]);
const checkout = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isInside = (base, target) => {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateSource(value, allowLocalHttp = false) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:'))
    throw new Error('Source must use HTTPS; local HTTP requires --allow-local-http.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Source must be an origin without credentials, query or path.');
  return url.origin;
}

export async function readMigrationSecret(filename) {
  const actual = await realpath(filename);
  if (isInside(await realpath(checkout), actual))
    throw new Error('Keep the migration secret file outside the checkout.');
  const stat = await lstat(actual);
  if (!stat.isFile() || stat.size > 128) throw new Error('Invalid migration secret file.');
  const value = (await readFile(actual, 'utf8')).trim();
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new Error('Migration secret must be 64 hexadecimal characters.');
  return value;
}

export function migrationClient({ sourceUrl, secret, allowLocalHttp = false, fetchImpl = fetch }) {
  const origin = validateSource(sourceUrl, allowLocalHttp);
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error('Invalid migration secret.');
  return {
    origin,
    async request(resource, { method = 'GET', snapshot, confirm = false } = {}) {
      const response = await fetchImpl(`${origin}/api/migration/${resource}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
        headers: {
          'x-migration-key': secret,
          ...(snapshot ? { 'x-migration-snapshot': String(snapshot) } : {}),
          ...(confirm ? { 'x-confirm-migration-window': 'yes' } : {}),
        },
      });
      if (!response.ok) throw new Error(`Migration endpoint returned HTTP ${response.status}.`);
      return response;
    },
  };
}

function assertStatus(status) {
  if (
    status.schemaVersion !== 6 ||
    status.frozen !== true ||
    status.snapshotReady !== true ||
    !Number.isSafeInteger(status.frozenAt) ||
    status.frozenAt <= 0 ||
    !Number.isSafeInteger(status.requiredObjects) ||
    status.requiredObjects < 0 ||
    Object.keys(status.counts || {})
      .sort()
      .join(',') !== [...TABLES].sort().join(',') ||
    TABLES.some((table) => !Number.isSafeInteger(status.counts[table]) || status.counts[table] < 0)
  )
    throw new Error('A complete frozen schema-version-6 snapshot is required.');
}

function addReferences(table, rows, refs, blobs) {
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('Invalid table row.');
    const key = table === 'tasks' ? row.file_key : table === 'answers' ? row.solution_key : null;
    if (key !== null && key !== undefined) {
      if (typeof key !== 'string' || !key || key.length > 512)
        throw new Error('Invalid photo reference.');
      refs.add(key);
    }
    if (table === 'blobs') blobs.set(row.key, row.state);
  }
}

/** No automatic freeze or unfreeze: changing live availability is a separate explicit command. */
export async function downloadSnapshot(client, output, { paceMs = 50 } = {}) {
  const initial = await (await client.request('status')).json();
  assertStatus(initial);
  const destination = path.resolve(output);
  const parent = await realpath(path.dirname(destination));
  if (isInside(await realpath(checkout), parent))
    throw new Error('Store snapshots outside the checkout.');
  // Existing directories, even empty ones, are refused. A failed run remains visibly incomplete.
  await mkdir(destination, { mode: 0o700 });
  await writeFile(path.join(destination, 'INCOMPLETE'), 'Snapshot download is incomplete.\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await mkdir(path.join(destination, 'tables'), { mode: 0o700 });
  await mkdir(path.join(destination, 'objects'), { mode: 0o700 });
  const manifest = {
    format: 'taskbattle-migration',
    schemaVersion: 6,
    sourceOrigin: client.origin,
    frozenAt: initial.frozenAt,
    exportedAt: Date.now(),
    counts: initial.counts,
    requiredObjects: initial.requiredObjects,
    tables: [],
    objects: [],
  };
  const refs = new Set(),
    blobs = new Map();
  for (const table of TABLES) {
    let cursor = null,
      page = 0,
      count = 0;
    const seen = new Set();
    do {
      const query = new URLSearchParams({ limit: '500', ...(cursor ? { cursor } : {}) });
      const result = await (
        await client.request(`tables/${table}?${query}`, { snapshot: initial.frozenAt })
      ).json();
      if (
        result.table !== table ||
        result.frozenAt !== initial.frozenAt ||
        !Array.isArray(result.rows) ||
        result.rows.length > 500 ||
        !(result.nextCursor === null || typeof result.nextCursor === 'string')
      )
        throw new Error('Invalid snapshot page.');
      count += result.rows.length;
      if (count > initial.counts[table]) throw new Error('Snapshot row count changed.');
      addReferences(table, result.rows, refs, blobs);
      const relative = `tables/${table}-${String(page++).padStart(6, '0')}.json`;
      const bytes = Buffer.from(JSON.stringify(result.rows) + '\n');
      await writeFile(path.join(destination, relative), bytes, { flag: 'wx', mode: 0o600 });
      manifest.tables.push({
        table,
        path: relative,
        rows: result.rows.length,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
      cursor = result.nextCursor;
      if (cursor) {
        if (seen.has(cursor) || !result.rows.length)
          throw new Error('Snapshot cursor did not advance.');
        seen.add(cursor);
      }
      await pause(paceMs);
    } while (cursor);
    if (count !== initial.counts[table]) throw new Error('Snapshot row count mismatch.');
  }
  if (refs.size !== initial.requiredObjects || [...refs].some((key) => blobs.get(key) !== 'live'))
    throw new Error('Snapshot has incomplete photo registrations.');
  for (const key of [...refs].sort()) {
    const response = await client.request(`object?${new URLSearchParams({ key })}`, {
      snapshot: initial.frozenAt,
    });
    if (response.headers.get('x-migration-snapshot') !== String(initial.frozenAt))
      throw new Error('Photo belongs to a different snapshot.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid photo size.');
    const relative = `objects/${sha256(key)}.bin`;
    await writeFile(path.join(destination, relative), bytes, { flag: 'wx', mode: 0o600 });
    manifest.objects.push({ key, path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    await pause(paceMs);
  }
  const final = await (await client.request('status')).json();
  assertStatus(final);
  if (
    final.frozenAt !== initial.frozenAt ||
    final.requiredObjects !== initial.requiredObjects ||
    TABLES.some((table) => final.counts[table] !== initial.counts[table])
  )
    throw new Error('Source changed while exporting. Start again in a new directory.');
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(destination, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(destination, 'manifest.sha256'), sha256(bytes) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await unlink(path.join(destination, 'INCOMPLETE'));
  await verifySnapshot(destination);
  return {
    tables: TABLES.length,
    rows: Object.values(initial.counts).reduce((a, b) => a + b, 0),
    objects: refs.size,
  };
}

export async function verifySnapshot(directory) {
  const base = await realpath(directory);
  async function readRegular(relative) {
    const filename = path.join(base, relative);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || !isInside(base, await realpath(filename)))
      throw new Error('Snapshot contains an unsafe file.');
    return readFile(filename);
  }
  const top = await readdir(base);
  if (
    top.sort().join(',') !==
    ['manifest.json', 'manifest.sha256', 'objects', 'tables'].sort().join(',')
  )
    throw new Error('Snapshot is incomplete or contains unexpected files.');
  for (const directory of ['tables', 'objects']) {
    const stat = await lstat(path.join(base, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid snapshot directory.');
  }
  const bytes = await readRegular('manifest.json');
  if ((await readRegular('manifest.sha256')).toString('utf8').trim() !== sha256(bytes))
    throw new Error('Manifest checksum mismatch.');
  const manifest = JSON.parse(bytes);
  assertStatus({ ...manifest, frozen: true, snapshotReady: true });
  if (
    manifest.format !== 'taskbattle-migration' ||
    !Array.isArray(manifest.tables) ||
    !Array.isArray(manifest.objects)
  )
    throw new Error('Unsupported snapshot format.');
  const counts = Object.fromEntries(TABLES.map((table) => [table, 0]));
  const seenFiles = new Set(),
    seenTables = new Set(),
    refs = new Set(),
    blobs = new Map();
  const photoKeys = new Set();
  for (const entry of [...manifest.tables, ...manifest.objects]) {
    const isTable = Object.hasOwn(entry, 'table');
    if (
      typeof entry.path !== 'string' ||
      !(isTable ? /^tables\/[a-z_]+-\d{6}\.json$/ : /^objects\/[a-f0-9]{64}\.bin$/).test(
        entry.path,
      ) ||
      seenFiles.has(entry.path) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0
    )
      throw new Error('Invalid snapshot file entry.');
    seenFiles.add(entry.path);
    const content = await readRegular(entry.path);
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256)
      throw new Error('Snapshot checksum mismatch.');
    if (isTable) {
      if (!TABLES.includes(entry.table) || !entry.path.startsWith(`tables/${entry.table}-`))
        throw new Error('Unexpected snapshot table.');
      const rows = JSON.parse(content);
      if (!Array.isArray(rows) || rows.length !== entry.rows || rows.length > 500)
        throw new Error('Invalid snapshot rows.');
      counts[entry.table] += rows.length;
      seenTables.add(entry.table);
      addReferences(entry.table, rows, refs, blobs);
    } else {
      if (
        typeof entry.key !== 'string' ||
        !entry.key ||
        photoKeys.has(entry.key) ||
        entry.path !== `objects/${sha256(entry.key)}.bin`
      )
        throw new Error('Invalid photo mapping.');
      photoKeys.add(entry.key);
    }
  }
  if (
    seenTables.size !== TABLES.length ||
    TABLES.some((table) => counts[table] !== manifest.counts[table]) ||
    refs.size !== manifest.requiredObjects ||
    photoKeys.size !== refs.size ||
    [...refs].some((key) => !photoKeys.has(key) || blobs.get(key) !== 'live')
  )
    throw new Error('Snapshot references or counts do not match.');
  for (const folder of ['tables', 'objects']) {
    const actual = await readdir(path.join(base, folder));
    if (
      actual.length !== [...seenFiles].filter((file) => file.startsWith(folder + '/')).length ||
      actual.some((file) => !seenFiles.has(`${folder}/${file}`))
    )
      throw new Error('Snapshot contains unexpected files.');
  }
  return manifest;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' && args.length === 0) {
    console.log(
      'Usage: node scripts/migration-transfer.mjs status|freeze|unfreeze|export --source-url HTTPS_ORIGIN --secret-file FILE [--output NEW_DIRECTORY] [--confirm-window]',
    );
    console.log(
      'Verify an existing snapshot: node scripts/migration-transfer.mjs verify --output DIRECTORY',
    );
    console.log(
      'Loopback tests only: --allow-local-http. Freeze requires drain mode and no unfinished attempts.',
    );
    return;
  }
  const options = new Map();
  const valued = new Set(['--source-url', '--secret-file', '--output']);
  const flags = new Set(['--allow-local-http', '--confirm-window']);
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (options.has(option) || (!valued.has(option) && !flags.has(option)))
      throw new Error('Unknown or duplicate option.');
    if (valued.has(option)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing option value.');
      options.set(option, args[++i]);
    } else options.set(option, true);
  }
  if (command === 'verify') {
    if (!options.get('--output')) throw new Error('Use verify --output SNAPSHOT_DIRECTORY.');
    await verifySnapshot(options.get('--output'));
    console.log('Snapshot verified.');
    return;
  }
  if (
    !['status', 'freeze', 'unfreeze', 'export'].includes(command) ||
    !options.get('--source-url') ||
    !options.get('--secret-file')
  )
    throw new Error(
      'Use status|freeze|unfreeze|export --source-url ORIGIN --secret-file FILE; export also requires --output NEW_DIRECTORY.',
    );
  if (command === 'export' && !options.get('--output'))
    throw new Error('Export requires --output NEW_DIRECTORY.');
  if (['freeze', 'unfreeze'].includes(command) && !options.get('--confirm-window'))
    throw new Error('Changing availability requires --confirm-window.');
  const client = migrationClient({
    sourceUrl: options.get('--source-url'),
    secret: await readMigrationSecret(options.get('--secret-file')),
    allowLocalHttp: options.has('--allow-local-http'),
  });
  if (command === 'export') {
    const result = await downloadSnapshot(client, options.get('--output'));
    console.log(
      `Snapshot verified: ${result.tables} tables, ${result.rows} rows, ${result.objects} photographs.`,
    );
  } else {
    const status = await (
      await client.request(command, {
        method: command === 'status' ? 'GET' : 'POST',
        confirm: options.has('--confirm-window'),
      })
    ).json();
    console.log(
      `Schema ${status.schemaVersion}; drain=${status.drainEnabled}; active attempts=${status.activeAttempts}; frozen=${status.frozen}; ready=${status.snapshotReady}; required photographs=${status.requiredObjects}.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    // Errors from HTTP, JSON, and filesystem libraries can contain private values or paths.
    console.error(
      'Migration operation failed. No successful snapshot is confirmed. Check options, access and the frozen source; never share secret files or snapshot contents.',
    );
    process.exitCode = 1;
  });
