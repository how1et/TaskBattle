import type { AttemptData } from './client';
export type SheetFormat = 'amc8' | 'free';
type Cell = { userEnteredValue?: { stringValue: string } | { numberValue: number } };
const cell = (value: string | number | null): Cell =>
  value === null
    ? {}
    : {
        userEnteredValue:
          typeof value === 'number' ? { numberValue: value } : { stringValue: value },
      };
export function sheetContent(
  data: AttemptData,
  format: SheetFormat,
  year: number | null,
  sheetId: number,
  marker: string,
) {
  if (!data.report || !data.summary || data.finishedAt === null)
    throw Error('Attempt is not finished');
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(data.finishedAt);
  const values: (string | number | null)[][] = [
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
      data.report.filter((t) => !t.submitted).reduce((s, t) => s + (t.durationMs || 0), 0) / 1000,
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
  const header = values.length - 1;
  if (format === 'amc8')
    for (let n = 1; n <= 25; n++) {
      const t = data.report.find((t) => t.ordinal === n);
      values.push(
        t
          ? [
              n,
              t.topic || '',
              (t.durationMs || 0) / 1000,
              t.correct === null ? 'Не решено' : t.correct ? 'Верно' : 'Неверно',
            ]
          : [n, '', null, 'Нет в подборке'],
      );
    }
  else {
    for (const t of data.report.filter((t) => t.submitted))
      values.push([
        t.ordinal,
        t.topic || '',
        (t.durationMs || 0) / 1000,
        t.correct ? 'Верно' : 'Неверно',
      ]);
    if (!data.summary.submitted) values.push(['Нет отправленных ответов']);
  }
  const name = `${format === 'amc8' ? 'AMC8' : 'Результаты'} ${new Date(data.finishedAt).toISOString().slice(0, 10)} ${data.attemptId.slice(0, 8)} ${marker.slice(0, 6)}`;
  const requests: unknown[] = [
    {
      addSheet: {
        properties: {
          sheetId,
          title: name,
          gridProperties: {
            rowCount: Math.max(50, values.length),
            columnCount: 4,
            frozenRowCount: header + 1,
          },
        },
      },
    },
    {
      updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
        rows: values.map((row) => ({ values: row.map(cell) })),
        fields: 'userEnteredValue',
      },
    },
    {
      repeatCell: {
        range: { sheetId },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat',
      },
    },
    ...[0, header].map((row) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: row, endRowIndex: row + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.07, green: 0.18, blue: 0.23 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 0.94, blue: 0.8 } },
          },
        },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat',
      },
    })),
    ...[5, 8].map((row) => ({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: row,
          endRowIndex: row + 1,
          startColumnIndex: 1,
          endColumnIndex: 2,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    })),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: header + 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    ...[250, 300, 130, 200].map((pixelSize, index) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
    {
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: 'taskbattleExport',
          metadataValue: marker,
          visibility: 'DOCUMENT',
          location: { sheetId },
        },
      },
    },
  ];
  return { requests };
}
