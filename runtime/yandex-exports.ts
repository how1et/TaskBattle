import type { DatabaseSync } from 'node:sqlite';
import type { AttemptData } from '../lib/client';
import { snapshot } from '../lib/server/attempts';
import { body, db, fail, limit, type Attempt, type Room } from '../lib/server/context';
import { createYandexDiskClient, DiskError } from './yandex-disk.mjs';
import { createWorkbookExporter, reportSheetData, WorkbookExportError } from './workbook.mjs';

type ExportConfig = {
  YANDEX_DISK_TOKEN?: string;
  YANDEX_DISK_PATH?: string;
  tokenProvider?: () => Promise<string> | string;
};

export async function exportResult(req: Request, attempt: Attempt, room: Room) {
  if (attempt.finished_at === null) fail(409, 'Сначала завершите попытку.');
  const input = await body(req);
  if (!['amc8', 'free'].includes(input.format)) fail(400, 'Выберите шаблон.');
  const config = (globalThis as typeof globalThis & { __taskbattleExportConfig?: ExportConfig })
    .__taskbattleExportConfig;
  if (!config?.YANDEX_DISK_PATH || (!config.tokenProvider && !config.YANDEX_DISK_TOKEN))
    fail(
      503,
      'Экспорт в Яндекс Диск ещё не подключён. Обратитесь к владельцу сайта.',
      'disk-setup',
    );
  await limit('yandex-export:' + attempt.id, 10, 60000);
  try {
    const connection = (db() as unknown as { connection: DatabaseSync }).connection;
    if (!connection) fail(503, 'Экспорт временно недоступен.', 'disk-setup');
    const exporter = createWorkbookExporter({
      connection,
      path: config!.YANDEX_DISK_PATH!,
      disk: createYandexDiskClient({
        tokenProvider: config!.tokenProvider || (() => config!.YANDEX_DISK_TOKEN!),
      }),
    });
    const prior = connection
      .prepare('SELECT id FROM yandex_export_jobs WHERE attempt_id=? AND format=?')
      .get(attempt.id, input.format) as { id: string } | undefined;
    let id = prior?.id;
    if (!id) {
      const year = room.amc_year ?? (input.year ? Number(input.year) : null);
      const report = (await snapshot(attempt, room)) as AttemptData;
      const job = exporter.enqueue({
        attemptId: attempt.id,
        format: input.format,
        content: reportSheetData(report, input.format, year),
      });
      id = job.id;
    }
    return await exporter.process(id!);
  } catch (error) {
    if (!(error instanceof DiskError) && !(error instanceof WorkbookExportError)) throw error;
    const messages: Record<string, string> = {
      'export-ambiguous':
        'Загрузка ещё проверяется. Повторите проверку экспорта позже; новая загрузка пока приостановлена.',
      'export-busy': 'Другой результат сейчас сохраняется. Повторите экспорт немного позже.',
      'export-conflict':
        'Файл изменён вне TaskBattle. Экспорт приостановлен; обратитесь к владельцу сайта.',
      'export-owner':
        'Этот файл не принадлежит TaskBattle. Выберите отдельный файл для результатов.',
      'export-unsupported':
        'В файле появились неподдерживаемые объекты. Экспорт приостановлен; файл сохранён без изменений.',
      'export-workbook': 'Не удалось проверить файл результатов. Обратитесь к владельцу сайта.',
      'export-size': 'Файл результатов достиг допустимого размера. Обратитесь к владельцу сайта.',
      'disk-size': 'Файл результатов достиг допустимого размера. Обратитесь к владельцу сайта.',
      'export-year': 'Укажите год AMC от 1900 до 2200.',
      'disk-auth': 'Нет доступа к Яндекс Диску. Владельцу сайта нужно обновить подключение.',
      maintenance: 'Сайт временно закрыт на обслуживание. Попробуйте позже.',
    };
    fail(
      error.status || 503,
      messages[error.code] || 'Не удалось сохранить результат на Яндекс Диск. Попробуйте позже.',
      error.code,
    );
  }
}
