import { LIMITS } from './limits';
export class PhotoLoadError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export async function fetchPhoto(
  path: string,
  key: string,
  teacher: boolean,
  signal: AbortSignal,
): Promise<string> {
  let url: string | undefined;
  const img = new Image();
  let rejectAbort!: (e: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    if (url) {
      URL.revokeObjectURL(url);
      url = undefined;
    }
    img.src = '';
    rejectAbort(new DOMException('Cancelled', 'AbortError'));
  };
  signal.addEventListener('abort', abort, { once: true });
  // Attach immediately: abort can happen while fetch/blob is still in flight.
  void stopped.catch(() => {});
  try {
    const r = await fetch(path, {
      cache: 'no-store',
      signal,
      headers: key ? { [teacher ? 'x-teacher-key' : 'x-attempt-key']: key } : {},
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new PhotoLoadError(
        data.error || 'Не удалось загрузить фото. Повторите загрузку.',
        r.status,
      );
    }
    const blob = await r.blob();
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    url = URL.createObjectURL(blob);
    img.src = url;
    await Promise.race([img.decode(), stopped]);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return url;
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    throw e;
  } finally {
    img.src = '';
    signal.removeEventListener('abort', abort);
  }
}
type Handle = { promise: Promise<string>; release: () => void };
type Entry = {
  refs: number;
  controller: AbortController;
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
  url?: string;
  started: boolean;
  settled: boolean;
  path: string;
  key: string;
  teacher: boolean;
};
/** No immortal URL cache. A handle owns one reference until release/unmount. */
export class PhotoPool {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private active = 0;
  constructor(
    private load = fetchPhoto,
    private max: number = LIMITS.photoConcurrency,
    private timeoutMs: number = LIMITS.photoTimeoutMs,
  ) {}
  acquire(path: string, key = '', teacher = false): Handle {
    const id = JSON.stringify([path, key, teacher]);
    let entry = this.entries.get(id);
    if (!entry) {
      let resolve!: (v: string) => void, reject!: (e: unknown) => void;
      const promise = new Promise<string>((a, b) => {
        resolve = a;
        reject = b;
      });
      entry = {
        refs: 0,
        controller: new AbortController(),
        promise,
        resolve,
        reject,
        started: false,
        settled: false,
        path,
        key,
        teacher,
      };
      this.entries.set(id, entry);
      this.queue.push(entry);
    }
    const e = entry;
    e.refs++;
    this.drain();
    let released = false;
    return {
      promise: e.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--e.refs) return;
        if (this.entries.get(id) === e) this.entries.delete(id);
        e.controller.abort();
        if (e.url) URL.revokeObjectURL(e.url);
        if (!e.started) {
          e.settled = true;
          e.reject(new DOMException('Cancelled', 'AbortError'));
          this.queue = this.queue.filter((x) => x !== e);
        }
      },
    };
  }
  private drain() {
    while (this.active < this.max && this.queue.length) {
      const e = this.queue.shift()!;
      if (e.settled || !e.refs) continue;
      e.started = true;
      this.active++;
      void this.run(e).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
  private async run(e: Entry) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      const stop = () =>
        reject(new PhotoLoadError('Загрузка фото прервалась. Повторите загрузку.'));
      e.controller.signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => e.controller.abort(), this.timeoutMs);
    });
    const work = this.load(e.path, e.key, e.teacher, e.controller.signal).then((url) => {
      if (e.controller.signal.aborted || !e.refs) {
        URL.revokeObjectURL(url);
        throw new DOMException('Cancelled', 'AbortError');
      }
      return url;
    });
    try {
      e.url = await Promise.race([work, stopped]);
      e.resolve(e.url);
    } catch (error) {
      const id = JSON.stringify([e.path, e.key, e.teacher]);
      if (this.entries.get(id) === e) this.entries.delete(id);
      e.reject(
        error instanceof PhotoLoadError
          ? error
          : new PhotoLoadError('Не удалось открыть фото. Проверьте интернет и повторите загрузку.'),
      );
    } finally {
      e.settled = true;
      clearTimeout(timer);
    }
  }
  get size() {
    return this.entries.size;
  }
}
export const photoPool = new PhotoPool();
