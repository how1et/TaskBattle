import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { DiskError, diskWebUrl, MAX_WORKBOOK_BYTES, validateDiskPath } from './yandex-disk.mjs';

const META_SHEET = '_TaskBattle';
const META_SIGNATURE = 'TaskBattle workbook v1';
const inFlight = new WeakMap();
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class WorkbookExportError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'WorkbookExportError';
    this.code = code;
    this.status = status;
  }
}

// Cap expanded XLSX size before ExcelJS inflates it. Refuse package features
// ExcelJS cannot preserve faithfully, rather than silently removing them.
function inspectPackage(bytes) {
  if (bytes.length > MAX_WORKBOOK_BYTES) throw new WorkbookExportError('export-size', 413);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--)
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  if (end < 0) throw new WorkbookExportError('export-workbook');
  const count = bytes.readUInt16LE(end + 10),
    start = bytes.readUInt32LE(end + 16);
  if (count > 5000 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw new WorkbookExportError('export-size', 413);
  let offset = start,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new WorkbookExportError('export-workbook');
    const length = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + length + extra + comment > end || bytes.readUInt16LE(offset + 8) & 1)
      throw new WorkbookExportError('export-workbook');
    expanded += bytes.readUInt32LE(offset + 24);
    if (expanded > 80 * 1024 * 1024) throw new WorkbookExportError('export-size', 413);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + length);
    if (
      /^xl\/(charts|drawings|pivot|slicers|externalLinks|embeddings|connections|vbaProject)/i.test(
        name,
      )
    )
      throw new WorkbookExportError('export-unsupported');
    offset += 46 + length + extra + comment;
  }
}

async function loadWorkbook(bytes) {
  const workbook = new ExcelJS.Workbook();
  if (bytes) {
    inspectPackage(Buffer.from(bytes));
    try {
      await workbook.xlsx.load(bytes);
    } catch {
      throw new WorkbookExportError('export-workbook');
    }
  }
  return workbook;
}

function metadata(workbook, bookId) {
  const sheet = workbook.getWorksheet(META_SHEET);
  if (
    !sheet ||
    sheet.getCell('A1').value !== META_SIGNATURE ||
    sheet.getCell('B1').value !== bookId
  )
    throw new WorkbookExportError('export-owner');
  return sheet;
}

function findMarker(workbook, bookId, marker, fingerprint) {
  const meta = metadata(workbook, bookId);
  for (let index = 3; index <= meta.rowCount; index++) {
    const row = meta.getRow(index);
    if (row.getCell(3).value !== marker) continue;
    if (
      row.getCell(5).value !== fingerprint ||
      typeof row.getCell(4).value !== 'string' ||
      !workbook.getWorksheet(row.getCell(4).value)
    )
      throw new WorkbookExportError('export-owner');
    return row.getCell(4).value;
  }
  return null;
}

export async function verifyWorkbookMarker(bytes, bookId, marker, fingerprint) {
  return findMarker(await loadWorkbook(bytes), bookId, marker, fingerprint);
}

/** Values are typed: seconds remain numbers and user text never becomes a formula. */
export function reportSheetData(data, format, year) {
  if (
    !data.report ||
    !data.summary ||
    data.finishedAt === null ||
    !['amc8', 'free'].includes(format)
  )
    throw new WorkbookExportError('export-incomplete');
  if (format === 'amc8' && (!Number.isInteger(year) || year < 1900 || year > 2200))
    throw new WorkbookExportError('export-year', 400);
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(data.finishedAt);
  const values = [
    ['TaskBattle · ' + data.title],
    ['Идентификатор попытки', data.attemptId],
    ['Год AMC', year],
    ['Завершено (Москва, UTC+3)', date],
    [
      'Способ завершения',
      data.finishReason === 'manual'
        ? 'Досрочное'
        : data.finishReason === 'timeout'
          ? 'По истечении 24 часов'
          : 'Полное',
    ],
    ['Общее время, с', data.summary.totalMs / 1000],
    ['Задач в подборке', data.count],
    ['Отправленных ответов', data.summary.submitted],
    [
      'Время на задачи без ответа, с',
      data.report
        .filter((task) => !task.submitted)
        .reduce((total, task) => total + (task.durationMs || 0), 0) / 1000,
    ],
    [
      format === 'amc8'
        ? 'Номера соответствуют порядку задач в подборке'
        : 'В таблице только задачи с принятым ответом',
    ],
    ...(data.timingIncomplete
      ? [['Время сохранено частично: связь с предыдущей вкладкой была потеряна']]
      : []),
    ['№ задачи', 'Тема', 'Время, с', 'Статус'],
  ];
  const header = values.length;
  if (format === 'amc8') {
    for (let ordinal = 1; ordinal <= 25; ordinal++) {
      const task = data.report.find((item) => item.ordinal === ordinal);
      values.push(
        task
          ? [
              ordinal,
              task.topic || '',
              (task.durationMs || 0) / 1000,
              task.correct === null ? 'Не решено' : task.correct ? 'Верно' : 'Неверно',
            ]
          : [ordinal, '', null, 'Нет в подборке'],
      );
    }
  } else {
    for (const task of data.report.filter((item) => item.submitted))
      values.push([
        task.ordinal,
        task.topic || '',
        (task.durationMs || 0) / 1000,
        task.correct ? 'Верно' : 'Неверно',
      ]);
    if (!data.summary.submitted) values.push(['Нет отправленных ответов']);
  }
  return { values, header, date: new Date(data.finishedAt).toISOString().slice(0, 10) };
}

export async function appendResultWorksheet(existingBytes, job) {
  const workbook = await loadWorkbook(existingBytes);
  const payload = JSON.parse(job.payload);
  const fingerprint = sha256(job.payload);
  if (existingBytes) {
    const existing = findMarker(workbook, job.book_id, job.marker, fingerprint);
    if (existing)
      return { bytes: Buffer.from(existingBytes), name: existing, hash: sha256(existingBytes) };
  } else {
    workbook.creator = 'TaskBattle';
    workbook.created = new Date(job.created_at);
    const meta = workbook.addWorksheet(META_SHEET, { state: 'veryHidden' });
    meta.addRow([META_SIGNATURE, job.book_id]);
    meta.addRow(['attempt_id', 'format', 'marker', 'worksheet', 'payload_sha256']);
  }
  const name = `${job.format === 'amc8' ? 'AMC8' : 'Итог'} ${payload.date} ${job.marker.slice(0, 8)}`;
  if (workbook.getWorksheet(name)) throw new WorkbookExportError('export-owner');
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: payload.header }],
  });
  sheet.columns = [{ width: 39 }, { width: 43 }, { width: 17 }, { width: 22 }];
  for (const [index, values] of payload.values.entries()) {
    if (!Array.isArray(values) || values.length > 4)
      throw new WorkbookExportError('export-payload');
    const row = sheet.addRow(
      values.map((value) => {
        if (
          value === null ||
          typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value))
        )
          return value;
        throw new WorkbookExportError('export-payload');
      }),
    );
    row.height =
      index === 0
        ? 52
        : Math.min(
            96,
            Math.max(
              28,
              Math.ceil(Math.max(...values.map((value) => String(value ?? '').length)) / 39) * 17,
            ),
          );
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: 'Arial', size: 11, color: { argb: 'FF23313B' } };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (typeof cell.value === 'string') cell.numFmt = '@';
    });
  }
  sheet.mergeCells('A1:D1');
  for (const rowNumber of [1, payload.header]) {
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= 4; column++) {
      const cell = row.getCell(column);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF122F3B' } };
      cell.font = {
        name: 'Arial',
        size: rowNumber === 1 ? 17 : 11,
        bold: true,
        color: { argb: 'FFFFF0CC' },
      };
    }
  }
  sheet.getCell('B6').numFmt = '0.0';
  sheet.getCell('B9').numFmt = '0.0';
  for (let row = payload.header + 1; row <= sheet.rowCount; row++)
    sheet.getCell(row, 3).numFmt = '0.0';
  metadata(workbook, job.book_id).addRow([
    job.attempt_id,
    job.format,
    job.marker,
    name,
    fingerprint,
  ]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  if (bytes.length > MAX_WORKBOOK_BYTES) throw new WorkbookExportError('export-size', 413);
  return { bytes, name, hash: sha256(bytes) };
}

function transaction(connection, work) {
  connection.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    throw error;
  }
}

/** Persistent per-workbook queue. Uploading/ambiguous states NEVER issue another PUT. */
export function createWorkbookExporter({ connection, disk, path, now = Date.now }) {
  validateDiskPath(path);
  const getJob = (id) => connection.prepare('SELECT * FROM yandex_export_jobs WHERE id=?').get(id);
  const getBook = (bookPath) =>
    connection.prepare('SELECT * FROM yandex_export_books WHERE path=?').get(bookPath);
  const result = (job) => ({
    url: diskWebUrl(job.book_path),
    format: job.format,
    worksheet: job.worksheet_name,
  });
  const assertWritable = () => {
    if (connection.prepare('SELECT frozen FROM migration_gate WHERE singleton=1').get()?.frozen)
      throw new WorkbookExportError('maintenance', 503);
  };
  const complete = (job, name) =>
    transaction(connection, () => {
      connection
        .prepare(
          "UPDATE yandex_export_jobs SET status='complete',worksheet_name=?,payload_bytes=NULL,lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE id=? AND status IN ('uploading','ambiguous')",
        )
        .run(name, now(), now(), job.id);
      connection
        .prepare(
          'UPDATE yandex_export_books SET active_job=NULL,last_hash=?,updated_at=? WHERE path=? AND active_job=?',
        )
        .run(job.payload_hash, now(), job.book_path, job.id);
    });
  const reconcile = async (job) => {
    try {
      const remote = await disk.stat(job.book_path);
      if (!remote || remote.sha256 !== job.payload_hash) return false;
      const bytes = await disk.download(job.book_path);
      if (sha256(bytes) !== job.payload_hash) return false;
      const name = await verifyWorkbookMarker(bytes, job.book_id, job.marker, sha256(job.payload));
      if (!name) return false;
      complete(job, name);
      return true;
    } catch (error) {
      if (error instanceof DiskError && ['disk-auth', 'disk-setup'].includes(error.code))
        throw error;
      return false;
    }
  };
  const release = (job, token, status) =>
    transaction(connection, () => {
      const changed = connection
        .prepare(
          "UPDATE yandex_export_jobs SET status=?,payload_bytes=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='preparing'",
        )
        .run(status, now(), job.id, token).changes;
      if (changed && status !== 'conflict')
        connection
          .prepare(
            'UPDATE yandex_export_books SET active_job=NULL,updated_at=? WHERE path=? AND active_job=?',
          )
          .run(now(), job.book_path, job.id);
    });
  const processJob = async (requestedId) => {
    assertWritable();
    const requested = getJob(requestedId);
    if (!requested) throw new WorkbookExportError('export-missing', 404);
    if (requested.status === 'complete') return result(requested);
    const token = randomUUID();
    const claim = transaction(connection, () => {
      const book = getBook(requested.book_path);
      const job = book.active_job ? getJob(book.active_job) : getJob(requestedId);
      if (!job || job.book_id !== book.book_id) throw new WorkbookExportError('export-conflict');
      if (['uploading', 'ambiguous'].includes(job.status)) return { job, reconcile: true };
      if (job.status === 'conflict') throw new WorkbookExportError('export-conflict');
      if (job.status === 'preparing' && job.lease_until > now())
        throw new WorkbookExportError('export-busy');
      connection
        .prepare(
          "UPDATE yandex_export_jobs SET status='preparing',lease_token=?,lease_until=?,updated_at=? WHERE id=?",
        )
        .run(token, now() + 120000, now(), job.id);
      connection
        .prepare('UPDATE yandex_export_books SET active_job=?,updated_at=? WHERE path=?')
        .run(job.id, now(), job.book_path);
      return { job: getJob(job.id), reconcile: false };
    });
    let job = claim.job;
    if (claim.reconcile) {
      if (!(await reconcile(job))) {
        connection
          .prepare(
            "UPDATE yandex_export_jobs SET status='ambiguous',updated_at=? WHERE id=? AND status='uploading'",
          )
          .run(now(), job.id);
        throw new WorkbookExportError('export-ambiguous', 503);
      }
      return job.id === requestedId ? result(getJob(job.id)) : processJob(requestedId);
    }
    try {
      const book = getBook(job.book_path),
        remote = await disk.stat(job.book_path);
      const baseline = remote?.sha256 ?? null;
      if (book.last_hash !== null && baseline !== book.last_hash)
        throw new WorkbookExportError('export-conflict');
      let existing = null;
      if (remote) {
        existing = await disk.download(job.book_path);
        if (sha256(existing) !== baseline) throw new WorkbookExportError('export-conflict');
      }
      const payload = await appendResultWorksheet(existing, job);
      const upload = await disk.prepareUpload(job.book_path, Boolean(remote));
      // The Disk API has no documented compare-and-swap. Detect observed edits
      // immediately before PUT and require a dedicated workbook with no editors.
      const beforeUpload = await disk.stat(job.book_path);
      if ((beforeUpload?.sha256 ?? null) !== baseline)
        throw new WorkbookExportError('export-conflict');
      assertWritable();
      const stored = connection
        .prepare(
          "UPDATE yandex_export_jobs SET status='uploading',baseline_hash=?,payload_hash=?,payload_bytes=?,worksheet_name=?,updated_at=? WHERE id=? AND status='preparing' AND lease_token=? AND lease_until>?",
        )
        .run(
          baseline,
          payload.hash,
          payload.bytes,
          payload.name,
          now(),
          job.id,
          token,
          now(),
        ).changes;
      if (!stored) throw new WorkbookExportError('export-busy');
      job = getJob(job.id);
      try {
        await upload(payload.bytes);
      } catch (error) {
        if (error instanceof DiskError && !error.ambiguous) {
          transaction(connection, () => {
            connection
              .prepare(
                "UPDATE yandex_export_jobs SET status='retryable',payload_bytes=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='uploading'",
              )
              .run(now(), job.id);
            connection
              .prepare(
                'UPDATE yandex_export_books SET active_job=NULL,updated_at=? WHERE path=? AND active_job=?',
              )
              .run(now(), job.book_path, job.id);
          });
          throw error;
        }
      }
      if (!(await reconcile(job))) {
        connection
          .prepare(
            "UPDATE yandex_export_jobs SET status='ambiguous',updated_at=? WHERE id=? AND status='uploading'",
          )
          .run(now(), job.id);
        throw new WorkbookExportError('export-ambiguous', 503);
      }
      return job.id === requestedId ? result(getJob(job.id)) : processJob(requestedId);
    } catch (error) {
      const conflict =
        error instanceof WorkbookExportError &&
        ['export-conflict', 'export-owner', 'export-unsupported', 'export-workbook'].includes(
          error.code,
        );
      release(job, token, conflict ? 'conflict' : 'retryable');
      throw error;
    }
  };
  return {
    enqueue({ attemptId, format, content }) {
      assertWritable();
      if (typeof attemptId !== 'string' || !attemptId || !['amc8', 'free'].includes(format))
        throw new WorkbookExportError('export-payload', 400);
      const payload = JSON.stringify(content);
      if (Buffer.byteLength(payload) > 256 * 1024)
        throw new WorkbookExportError('export-size', 413);
      return transaction(connection, () => {
        const prior = connection
          .prepare('SELECT * FROM yandex_export_jobs WHERE attempt_id=? AND format=?')
          .get(attemptId, format);
        if (prior) return { ...prior };
        connection
          .prepare(
            'INSERT OR IGNORE INTO yandex_export_books(path,book_id,updated_at) VALUES(?,?,?)',
          )
          .run(path, randomUUID(), now());
        const book = getBook(path),
          id = randomUUID();
        connection
          .prepare(
            "INSERT INTO yandex_export_jobs(id,attempt_id,format,book_path,book_id,marker,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)",
          )
          .run(id, attemptId, format, path, book.book_id, randomUUID(), payload, now(), now());
        return { ...getJob(id) };
      });
    },
    process(id) {
      const job = getJob(id);
      if (!job) return Promise.reject(new WorkbookExportError('export-missing', 404));
      let queue = inFlight.get(connection);
      if (!queue) {
        queue = new Map();
        inFlight.set(connection, queue);
      }
      const previous = queue.get(job.book_path) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => processJob(id));
      queue.set(job.book_path, next);
      void next
        .finally(() => {
          if (queue.get(job.book_path) === next) queue.delete(job.book_path);
        })
        .catch(() => {});
      return next;
    },
  };
}
