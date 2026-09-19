export type CreatedRoom = { roomId: string; teacherKey: string; expiresAt: number };

export class UploadError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const connectionMessage =
  'Связь прервалась. Фотографии и ответы остались в форме. Нажмите «Повторить создание» и не обновляйте страницу.';

async function jsonRequest<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
    let data: T & { error?: string };
    try {
      data = await response.json();
    } catch {
      throw new UploadError(
        response.ok
          ? connectionMessage
          : 'Создание временно недоступно. Повторите через минуту. Фотографии и ответы остались в форме.',
        response.ok ? 0 : response.status,
      );
    }
    if (!response.ok)
      throw new UploadError(
        data.error || 'Не удалось создать комнату. Нажмите «Повторить создание».',
        response.status,
      );
    return data;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(connectionMessage, 0);
  } finally {
    clearTimeout(timeout);
  }
}

export async function recoverRoom(
  requestId: string,
  teacherKey: string,
): Promise<CreatedRoom | null> {
  try {
    return await jsonRequest<CreatedRoom>(
      `/api/creations/${encodeURIComponent(requestId)}`,
      { headers: { 'x-teacher-key': teacherKey } },
      15000,
    );
  } catch (error) {
    if (error instanceof UploadError && error.status === 404) return null;
    throw error;
  }
}

/** All sends share the same immutable FormData and idempotency key. */
export async function uploadRoom(
  data: FormData,
  onProgress: (message: string) => void,
): Promise<CreatedRoom> {
  const requestId = String(data.get('requestId'));
  const teacherKey = String(data.get('teacherKey'));
  onProgress('Проверяем, готова ли комната…');
  try {
    const saved = await recoverRoom(requestId, teacherKey);
    if (saved) return saved;
  } catch (error) {
    if (error instanceof UploadError && error.status === 410) throw error;
  }
  for (let send = 0; send < 2; send++) {
    onProgress(send ? 'Повторяем загрузку фотографий…' : 'Загружаем фотографии и создаём комнату…');
    try {
      return await jsonRequest<CreatedRoom>('/api/rooms', { method: 'POST', body: data }, 120000);
    } catch (error) {
      // Validation/access errors must not cause more uploads.
      if (error instanceof UploadError && error.status >= 400 && error.status < 500) throw error;
      onProgress('Проверяем, готова ли комната…');
      try {
        const saved = await recoverRoom(requestId, teacherKey);
        if (saved) return saved;
      } catch (recoveryError) {
        if (recoveryError instanceof UploadError && recoveryError.status === 410)
          throw recoveryError;
      }
      if (send === 1) throw new UploadError(connectionMessage, 0);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new UploadError(connectionMessage, 0);
}
