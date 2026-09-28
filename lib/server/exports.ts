import type { AttemptData } from '../client';
import { sheetContent, type SheetFormat } from '../sheet-content';
import { snapshot } from './attempts';
import { body, fail, limit, sql, type Attempt, type Room } from './context';
import { googleConfig, googleRequest } from './google-sheets';
type Export = {
  attempt_id: string;
  format: SheetFormat;
  document_id: string;
  sheet_id: number;
  marker: string;
  payload: string;
  completed: number;
};
export async function exportResult(req: Request, a: Attempt, r: Room) {
  if (a.finished_at === null) fail(409, 'Сначала завершите попытку.');
  const input = await body(req);
  if (!['amc8', 'free'].includes(input.format)) fail(400, 'Выберите шаблон.');
  const link = (op: Export) => ({
    url: `https://docs.google.com/spreadsheets/d/${op.document_id}/edit#gid=${op.sheet_id}`,
    format: op.format,
  });
  let op = await sql(
    'SELECT * FROM sheet_exports WHERE attempt_id=? AND format=?',
    a.id,
    input.format,
  ).first<Export>();
  if (op?.completed) return link(op);
  const { id } = googleConfig();
  await limit('export:' + a.id, 10, 60000);
  if (!op) {
    const year = r.amc_year ?? (input.year ? Number(input.year) : null);
    if (
      input.format === 'amc8' &&
      (year === null || !Number.isInteger(year) || year < 1900 || year > 2200)
    )
      fail(400, 'Укажите год AMC от 1900 до 2200.');
    const sheetId = (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1,
      marker = crypto.randomUUID();
    const report = (await snapshot(a, r)) as AttemptData;
    const payload = JSON.stringify(sheetContent(report, input.format, year, sheetId, marker));
    await sql(
      'INSERT OR IGNORE INTO sheet_exports(attempt_id,format,document_id,sheet_id,marker,payload) VALUES(?,?,?,?,?,?)',
      a.id,
      input.format,
      id,
      sheetId,
      marker,
      payload,
    ).run();
    op = await sql(
      'SELECT * FROM sheet_exports WHERE attempt_id=? AND format=?',
      a.id,
      input.format,
    ).first<Export>();
  }
  const saved = op!;
  async function exists() {
    const doc = (await googleRequest(
      saved.document_id +
        '?fields=sheets(properties(sheetId),developerMetadata(metadataKey,metadataValue))',
    )) as {
      sheets?: {
        properties: { sheetId: number };
        developerMetadata?: { metadataKey: string; metadataValue: string }[];
      }[];
    };
    const sheet = doc.sheets?.find((s) => s.properties.sheetId === saved.sheet_id);
    if (!sheet) return false;
    if (
      !sheet.developerMetadata?.some(
        (m) => m.metadataKey === 'taskbattleExport' && m.metadataValue === saved.marker,
      )
    )
      fail(409, 'Номер листа уже занят. Обратитесь к владельцу сайта; чужой лист не изменён.');
    return true;
  }
  if (!(await exists())) {
    try {
      await googleRequest(saved.document_id + ':batchUpdate', JSON.parse(saved.payload));
    } catch (e) {
      if (!(await exists())) throw e;
    }
  }
  await sql(
    'UPDATE sheet_exports SET completed=1 WHERE attempt_id=? AND format=?',
    a.id,
    input.format,
  ).run();
  return link(saved);
}
