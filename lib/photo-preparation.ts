import { inspectImage } from './image-file';
import { LIMITS } from './limits';
const MAX_INPUT = LIMITS.inputBytes,
  MAX_OUTPUT = LIMITS.fileBytes;
let queue = Promise.resolve();
export function preparePhoto(file: File, signal?: AbortSignal): Promise<File> {
  const work = queue.then(() => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return prepare(file, signal);
  });
  queue = work.then(
    () => {},
    () => {},
  );
  return work;
}
export class PhotoError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}
async function bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (e: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort(new DOMException('Cancelled', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([
      work,
      stopped,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PhotoError('processing', 'Не удалось обработать фото. Выберите другой снимок.'),
            ),
          LIMITS.imageTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
/** Decode applies EXIF orientation. Canvas creates independent bytes, not a camera-backed File. */
async function prepare(file: File, signal?: AbortSignal): Promise<File> {
  if (!file.size) throw new PhotoError('empty', 'Снимок пустой. Сделайте фото ещё раз.');
  if (file.size > MAX_INPUT)
    throw new PhotoError('size', 'Файл слишком большой. Выберите фото до 30 МБ.');
  let url: string | undefined, canvas: HTMLCanvasElement | undefined;
  const img = new Image();
  try {
    const head = new Uint8Array(await bounded(file.slice(0, 16).arrayBuffer(), signal));
    const signature =
      head[0] === 255 && head[1] === 216
        ? 'image/jpeg'
        : [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => head[i] === v)
          ? 'image/png'
          : String.fromCharCode(...head.slice(0, 4)) === 'RIFF' &&
              String.fromCharCode(...head.slice(8, 12)) === 'WEBP'
            ? 'image/webp'
            : null;
    if (!signature)
      throw new PhotoError(
        'format',
        'Формат не поддерживается. Выберите JPEG, PNG или WebP; HEIC сохраните как JPEG.',
      );
    url = URL.createObjectURL(file);
    img.src = url;
    await bounded(img.decode(), signal);
    if (
      !img.naturalWidth ||
      !img.naturalHeight ||
      img.naturalWidth * img.naturalHeight > LIMITS.inputPixels
    )
      throw new PhotoError('size', 'Фотография слишком большая. Выберите снимок до 60 Мп.');
    let scale = Math.min(1, LIMITS.imageEdge / Math.max(img.naturalWidth, img.naturalHeight));
    canvas = document.createElement('canvas');
    for (let step = 0; step < 4; step++) {
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('Canvas unavailable');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const quality = step ? 0.84 : 0.9;
      const blob = await bounded(
        new Promise<Blob>((resolve, reject) =>
          canvas!.toBlob(
            (b) => (b ? resolve(b) : reject(Error('Encoding failed'))),
            'image/jpeg',
            quality,
          ),
        ),
        signal,
      );
      if (blob.size <= MAX_OUTPUT) {
        const bytes = await bounded(blob.arrayBuffer(), signal);
        if (!inspectImage(new Uint8Array(bytes))) throw Error('Invalid encoded image');
        return new File([bytes], 'photo.jpg', { type: 'image/jpeg' });
      }
      scale *= 0.8;
    }
    throw new PhotoError('size', 'Не удалось уменьшить фото до 3 МБ. Выберите другой снимок.');
  } catch (e) {
    if (e instanceof PhotoError) throw e;
    throw new PhotoError(
      'processing',
      'Не удалось обработать фото. Сделайте снимок ещё раз или выберите другой.',
    );
  } finally {
    if (url) URL.revokeObjectURL(url);
    img.src = '';
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
