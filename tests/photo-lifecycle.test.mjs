import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './load-module.mjs';
const deferred = () => Promise.withResolvers();
test('a stuck decoder times out, releases its URL, and a retry creates a fresh request', async () => {
  const real = {
    fetch,
    Image: globalThis.Image,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };
  let requests = 0,
    revoked = [],
    decoded = false;
  globalThis.fetch = async () => {
    requests++;
    return new Response(new Blob(['image']));
  };
  URL.createObjectURL = () => `blob:${requests}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.Image = class {
    decode() {
      return decoded ? Promise.resolve() : new Promise(() => {});
    }
  };
  try {
    const { PhotoPool } = await loadModule('../lib/photo-loader.ts');
    const pool = new PhotoPool(undefined, 2, 15);
    const first = pool.acquire('/photo');
    await assert.rejects(first.promise, /прервалась/);
    first.release();
    assert.equal(pool.size, 0);
    assert.ok(revoked.includes('blob:1'));
    decoded = true;
    const retry = pool.acquire('/photo');
    assert.equal(await retry.promise, 'blob:2');
    retry.release();
    assert.equal(requests, 2);
    assert.ok(revoked.includes('blob:2'));
    assert.equal(pool.size, 0);
  } finally {
    globalThis.fetch = real.fetch;
    globalThis.Image = real.Image;
    URL.createObjectURL = real.create;
    URL.revokeObjectURL = real.revoke;
  }
});
test('25 photo transitions keep only a three-task window, at most two loads, and release every URL', async () => {
  const { PhotoPool } = await loadModule('../lib/photo-loader.ts');
  let active = 0,
    peak = 0,
    revoked = [];
  const gates = new Map(),
    revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => revoked.push(url);
  const pool = new PhotoPool(
      async (path) => {
        active++;
        peak = Math.max(peak, active);
        const gate = deferred();
        gates.set(path, gate);
        await gate.promise;
        active--;
        return 'blob:' + path;
      },
      2,
      1000,
    ),
    held = new Map();
  try {
    for (let i = 0; i < 25; i++) {
      for (const [id, h] of held)
        if (id < i) {
          h.release();
          held.delete(id);
        }
      for (let n = i; n < Math.min(i + 3, 25); n++)
        if (!held.has(n)) {
          const h = pool.acquire(String(n));
          held.set(n, h);
          h.promise.catch(() => {});
        }
      for (let round = 0; round < 3; round++) {
        for (const gate of gates.values()) gate.resolve();
        await new Promise((r) => setImmediate(r));
      }
      await held.get(i).promise;
      assert.ok(pool.size <= 3);
    }
    for (const h of held.values()) h.release();
    assert.equal(peak, 2);
    assert.equal(pool.size, 0);
    assert.equal(new Set(revoked).size, 25);
  } finally {
    URL.revokeObjectURL = revoke;
  }
});
test('cancelled photo work cannot leak a late URL into its replacement', async () => {
  const { PhotoPool } = await loadModule('../lib/photo-loader.ts'),
    gate = deferred(),
    revoked = [],
    revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const pool = new PhotoPool(async () => {
      await gate.promise;
      return 'blob:late';
    });
    const old = pool.acquire('/old');
    old.release();
    await assert.rejects(old.promise);
    gate.resolve();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(revoked, ['blob:late']);
    assert.equal(pool.size, 0);
  } finally {
    URL.revokeObjectURL = revoke;
  }
});
test('typing coalesces into one latest draft write and does not synchronously touch storage', async () => {
  let writes = 0,
    syncWrites = 0,
    last;
  const previous = { indexedDB: globalThis.indexedDB, sessionStorage: globalThis.sessionStorage };
  globalThis.sessionStorage = {
    setItem() {
      syncWrites++;
    },
    getItem() {
      return null;
    },
    removeItem() {},
  };
  const db = {
    transaction() {
      const tx = {
        abort() {},
        objectStore() {
          return {
            put(v) {
              writes++;
              last = v;
              queueMicrotask(() => tx.oncomplete?.());
            },
            delete() {
              queueMicrotask(() => tx.oncomplete?.());
            },
          };
        },
      };
      return tx;
    },
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  try {
    const { saveDraft } = await loadModule('../lib/answer-draft.ts');
    let promises = [];
    for (let i = 1; i <= 200; i++)
      promises.push(saveDraft({ id: 'draft', position: 0, answer: 'a'.repeat(i), photo: null }));
    assert.equal(syncWrites, 0);
    await Promise.all(promises);
    assert.equal(writes, 1);
    assert.equal(syncWrites, 1);
    assert.equal(last.answer.length, 200);
  } finally {
    globalThis.indexedDB = previous.indexedDB;
    globalThis.sessionStorage = previous.sessionStorage;
  }
});
