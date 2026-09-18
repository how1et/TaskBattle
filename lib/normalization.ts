/** Deliberately strict: expressions, punctuation and interior spaces are preserved. */
export function normalizeAnswer(raw: string): string {
    const value = raw.trim().toLowerCase().replace(/\u2212/g, '-');
    if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value))
        return `text:${value}`;
    const negative = value.startsWith('-');
    const unsigned = value.replace(/^[+-]/, '');
    const [whole = '', fraction = ''] = unsigned.replace(',', '.').split('.');
    const integer = whole.replace(/^0+/, '') || '0';
    const decimal = fraction.replace(/0+$/, '');
    const zero = integer === '0' && !decimal;
    return `number:${negative && !zero ? '-' : ''}${integer}${decimal ? '.' + decimal : ''}`;
}
export function summarize(rows: {
    durationMs: number;
    ordinal: number;
    correct: boolean;
}[], _legacyTotalMs?: number) {
    const totalMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
    const min = Math.min(...rows.map(r => r.durationMs));
    const max = Math.max(...rows.map(r => r.durationMs));
    return { totalMs, averageMs: totalMs / rows.length, correct: rows.filter(r => r.correct).length, count: rows.length, fastest: { ordinals: rows.filter(r => r.durationMs === min).map(r => r.ordinal), durationMs: min }, slowest: { ordinals: rows.filter(r => r.durationMs === max).map(r => r.ordinal), durationMs: max } };
}
