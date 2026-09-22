/** Deliberately strict: expressions, punctuation and interior spaces are preserved. */
export function normalizeAnswer(raw: string): string {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/\u2212/g, '-');
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value)) return `text:${value}`;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [whole = '', fraction = ''] = unsigned.replace(',', '.').split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  const decimal = fraction.replace(/0+$/, '');
  const zero = integer === '0' && !decimal;
  return `number:${negative && !zero ? '-' : ''}${integer}${decimal ? '.' + decimal : ''}`;
}
export function summarize(
  rows: {
    durationMs: number | null;
    ordinal: number;
    correct: boolean | null;
  }[],
  _legacyTotalMs?: number,
  unfinishedMs = 0,
) {
  const submitted = rows.filter(
    (r): r is { durationMs: number; ordinal: number; correct: boolean } =>
      r.durationMs !== null && r.correct !== null,
  );
  const submittedMs = submitted.reduce((sum, row) => sum + row.durationMs, 0);
  const totalMs = submittedMs + unfinishedMs;
  const min = Math.min(...submitted.map((r) => r.durationMs));
  const max = Math.max(...submitted.map((r) => r.durationMs));
  return {
    totalMs,
    averageMs: submitted.length ? submittedMs / submitted.length : null,
    submitted: submitted.length,
    wrong: submitted.filter((r) => !r.correct).length,
    unsolved: rows.length - submitted.length,
    correct: rows.filter((r) => r.correct).length,
    count: rows.length,
    fastest: submitted.length
      ? {
          ordinals: submitted.filter((r) => r.durationMs === min).map((r) => r.ordinal),
          durationMs: min,
        }
      : null,
    slowest: submitted.length
      ? {
          ordinals: submitted.filter((r) => r.durationMs === max).map((r) => r.ordinal),
          durationMs: max,
        }
      : null,
  };
}
