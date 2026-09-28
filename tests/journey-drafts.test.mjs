import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './load-module.mjs';
const { visitTime, freezeVisit } = await loadModule('../lib/journey-draft.ts');
test('visit freeze excludes failed request wait and resumes accumulated solution time', () => {
  const running = { id: 'visit-1', taskId: 'task-5', start: 1000, elapsed: 400 };
  const frozen = freezeVisit(running, 1600);
  assert.equal(visitTime(frozen, 50000), 1000);
  assert.deepEqual(freezeVisit(frozen, 50000), frozen);
  assert.equal(visitTime({ ...frozen, start: 50000 }, 50500), 1500);
  assert.equal(frozen.taskId, 'task-5');
});
test('1→5→2→5 drafts keep independent text and file when persistent local storage refuses writes', async () => {
  const real = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem() {
      throw new DOMException('Denied', 'SecurityError');
    },
    setItem() {
      throw new DOMException('Quota', 'QuotaExceededError');
    },
  };
  try {
    const { readDraft, saveDraft } = await loadModule('../lib/answer-draft.ts');
    const one = new File(['photo-one'], 'one.png', { type: 'image/png' }),
      five = new File(['photo-five'], 'five.png', { type: 'image/png' });
    const id = (n) => 'journey:test-attempt:task-' + n;
    for (const d of [
      { id: id(1), position: 0, answer: 'draft1', photo: one, photoId: 'one', dirty: true },
      { id: id(5), position: 4, answer: 'draft5', photo: five, photoId: 'five', dirty: true },
      { id: id(2), position: 1, answer: 'draft2', photo: null, dirty: true },
    ]) {
      assert.ok(await saveDraft(d, true));
    }
    const back = (await readDraft(id(5))).draft;
    assert.equal(back.answer, 'draft5');
    assert.equal(await back.photo.text(), 'photo-five');
    assert.equal((await readDraft(id(1))).draft.answer, 'draft1');
    assert.equal((await readDraft(id(2))).draft.photo, null);
    await saveDraft(
      { ...back, answer: 'edited5', photo: null, photoExpected: false, dirty: true },
      true,
    );
    assert.equal((await readDraft(id(5))).draft.answer, 'edited5');
    assert.equal((await readDraft(id(1))).draft.photo, one);
  } finally {
    globalThis.sessionStorage = real;
  }
});
