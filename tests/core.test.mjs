import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, summarize } from '../lib/normalization.ts';
test('strict short-answer normalization', () => {
  for (const pair of [
    ['5', '5,00'],
    ['−5', '-5'],
    ['  Ответ  ', 'ответ'],
    ['0005.20', '5,2'],
    ['-0.000', '0'],
    ['.5', '0,50'],
  ])
    assert.equal(normalizeAnswer(pair[0]), normalizeAnswer(pair[1]));
  for (const pair of [
    ['9007199254740992', '9007199254740993'],
    ['a,b', 'a.b'],
    ['1/2', '0.5'],
    ['1 000', '1000'],
    ['ё', 'е'],
    ['x + y', 'x+y'],
    ['5foo', '5'],
  ])
    assert.notEqual(normalizeAnswer(pair[0]), normalizeAnswer(pair[1]));
});
test('all tied extrema are retained and mean uses total', () => {
  const rows = [
    { ordinal: 1, durationMs: 100, correct: true },
    { ordinal: 2, durationMs: 200, correct: false },
    { ordinal: 3, durationMs: 100, correct: true },
    { ordinal: 4, durationMs: 200, correct: false },
  ];
  const s = summarize(rows, 600);
  assert.deepEqual(s.fastest.ordinals, [1, 3]);
  assert.deepEqual(s.slowest.ordinals, [2, 4]);
  assert.equal(s.averageMs, 150);
  assert.equal(s.correct, 2);
  const all = summarize(
    rows.map((r) => ({ ...r, durationMs: 100 })),
    400,
  );
  assert.deepEqual(all.fastest.ordinals, [1, 2, 3, 4]);
  assert.deepEqual(all.slowest.ordinals, [1, 2, 3, 4]);
});
