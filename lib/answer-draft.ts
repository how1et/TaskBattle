export type Activation = { readyId: string; startedAt: number; wallStartedAt: number };
export type AnswerPayload = {
  requestId: string;
  taskId: string;
  position: number;
  answer: string;
  durationMs: number;
  readyId: string;
};
export type AnswerDraft = {
  id: string;
  position: number;
  answer: string;
  photo: File | null;
  photoId?: string;
  photoExpected?: boolean;
  activation?: Activation;
  resume?: { elapsedMs: number; wallStartedAt: number };
  payload?: AnswerPayload;
  sent?: boolean;
};
export type DraftRead = { draft?: AnswerDraft; warning?: string };
export const storageWarning =
  'Черновик доступен только в этой вкладке. Не закрывайте её до отправки.';
let database: Promise<IDBDatabase> | undefined;
const cache = new Map<string, AnswerDraft>();
const savedPhotos = new Map<string, string>();
const encoded = new WeakMap<Blob, Promise<ArrayBuffer>>();
let writing = Promise.resolve();
let scheduled: ReturnType<typeof setTimeout> | undefined;
let draining = false;
type Pending = {
  draft: AnswerDraft;
  promise: Promise<string | undefined>;
  resolve: (warning: string | undefined) => void;
};
const pending = new Map<string, Pending>();
let unavailableUntil = 0;
function diagnostic(phase: string, e: unknown) {
  console.warn(
    JSON.stringify({
      event: 'draft-cache-unavailable',
      phase,
      errorName: e instanceof Error ? e.name : 'UnknownError',
    }),
  );
}
function metadata(d: AnswerDraft) {
  return { ...d, photo: null, photoExpected: !!d.photo || !!d.photoExpected };
}
function fallback(d: AnswerDraft) {
  try {
    sessionStorage.setItem('draft-meta:' + d.id, JSON.stringify(metadata(d)));
  } catch {
    /* Never store photo bytes in synchronous storage. */
  }
}
function readFallback(id: string): AnswerDraft | undefined {
  try {
    return JSON.parse(sessionStorage.getItem('draft-meta:' + id) || 'null') || undefined;
  } catch {
    return undefined;
  }
}
function open() {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      database = undefined;
      reject(new DOMException('Draft cache timed out', 'TimeoutError'));
    }, 1500);
    try {
      const req = indexedDB.open('taskbattle-answers', 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('drafts'))
          req.result.createObjectStore('drafts', { keyPath: 'id' });
        if (!req.result.objectStoreNames.contains('photos'))
          req.result.createObjectStore('photos', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        if (done) {
          req.result.close();
          return;
        }
        done = true;
        req.result.onversionchange = () => {
          req.result.close();
          database = undefined;
        };
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        done = true;
        database = undefined;
        reject(req.error);
      };
    } catch (e) {
      clearTimeout(timer);
      done = true;
      database = undefined;
      reject(e);
    }
  });
  database.catch(() => {
    database = undefined;
  });
  return database;
}
function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, set: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | undefined, value: T;
    const timer = setTimeout(() => {
      try {
        tx?.abort();
      } catch {}
      reject(new DOMException('Draft transaction timed out', 'TimeoutError'));
    }, 1500);
    try {
      tx = db.transaction(['drafts', 'photos'], mode);
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve(value);
      };
      tx.onerror = tx.onabort = () => {
        clearTimeout(timer);
        reject(tx?.error || new DOMException('Draft transaction aborted', 'AbortError'));
      };
      work(tx, (v) => {
        value = v;
      });
    } catch (e) {
      clearTimeout(timer);
      try {
        tx?.abort();
      } catch {}
      reject(e);
    }
  });
}
export async function readDraft(id: string): Promise<DraftRead> {
  if (cache.has(id)) return { draft: cache.get(id) };
  const small = readFallback(id);
  try {
    const db = await open();
    const result = await transaction<{
      draft?: AnswerDraft;
      photo?: { photoId: string; bytes: ArrayBuffer; name: string; type: string };
    }>(db, 'readonly', (tx, set) => {
      const out: {
        draft?: AnswerDraft;
        photo?: { photoId: string; bytes: ArrayBuffer; name: string; type: string };
      } = {};
      const a = tx.objectStore('drafts').get(id),
        p = tx.objectStore('photos').get(id);
      a.onsuccess = () => {
        out.draft = a.result;
        set(out);
      };
      p.onsuccess = () => {
        out.photo = p.result;
        set(out);
      };
    });
    const d = small || result?.draft;
    if (!d) return {};
    const stored = result?.photo;
    if (stored && stored.photoId === d.photoId)
      d.photo = new File([stored.bytes], stored.name, { type: stored.type });
    else if (!small && result?.draft?.photo) d.photo = result.draft.photo; // v1 draft, before this fix
    if (d.photo) {
      d.photoId ||= crypto.randomUUID();
      d.photoExpected = true;
    }
    cache.set(id, d);
    return { draft: d };
  } catch (e) {
    diagnostic('read', e);
    if (small) cache.set(id, small);
    return { draft: small, warning: storageWarning };
  }
}
async function writeCached(d: AnswerDraft): Promise<string | undefined> {
  fallback(d);
  if (Date.now() < unavailableUntil) return storageWarning;
  try {
    const db = await open();
    let bytes: ArrayBuffer | undefined;
    if (d.photo && savedPhotos.get(d.id) !== d.photoId) {
      let pending = encoded.get(d.photo);
      if (!pending) {
        pending = d.photo.arrayBuffer();
        encoded.set(d.photo, pending);
      }
      bytes = await pending;
    }
    await transaction<void>(db, 'readwrite', (tx) => {
      tx.objectStore('drafts').put(metadata(d));
      if (d.photo && bytes)
        tx.objectStore('photos').put({
          id: d.id,
          photoId: d.photoId,
          bytes,
          name: d.photo.name,
          type: d.photo.type,
        });
      else if (!d.photo && !d.photoExpected) tx.objectStore('photos').delete(d.id);
    });
    if (d.photoId && d.photo) savedPhotos.set(d.id, d.photoId);
    else savedPhotos.delete(d.id);
    return undefined;
  } catch (e) {
    unavailableUntil = Date.now() + 15000;
    diagnostic('write', e);
    return storageWarning;
  }
}
function drain() {
  clearTimeout(scheduled);
  scheduled = undefined;
  if (draining) return;
  draining = true;
  writing = (async () => {
    while (pending.size) {
      const [id, item] = pending.entries().next().value!;
      pending.delete(id);
      item.resolve(await writeCached(item.draft));
    }
  })().finally(() => {
    draining = false;
    if (pending.size) drain();
  });
}
export function saveDraft(d: AnswerDraft, urgent = false): Promise<string | undefined> {
  cache.set(d.id, d);
  let item = pending.get(d.id);
  if (item) item.draft = d;
  else {
    let resolve!: (warning: string | undefined) => void;
    const promise = new Promise<string | undefined>((r) => {
      resolve = r;
    });
    item = { draft: d, promise, resolve };
    pending.set(d.id, item);
  }
  if (urgent) {
    fallback(d);
    drain();
  } else if (!scheduled && !draining) scheduled = setTimeout(drain, 250);
  return item.promise;
}
/** Flush tiny recovery metadata on pagehide; binary data never enters sessionStorage. */
export function flushDrafts() {
  for (const d of cache.values()) fallback(d);
  drain();
}
export async function removeDraft(id: string) {
  cache.delete(id);
  savedPhotos.delete(id);
  const queued = pending.get(id);
  pending.delete(id);
  queued?.resolve(undefined);
  try {
    sessionStorage.removeItem('draft-meta:' + id);
  } catch {}
  try {
    await writing;
    savedPhotos.delete(id);
    const db = await open();
    await transaction<void>(db, 'readwrite', (tx) => {
      tx.objectStore('drafts').delete(id);
      tx.objectStore('photos').delete(id);
    });
  } catch (e) {
    diagnostic('remove', e);
  }
}
