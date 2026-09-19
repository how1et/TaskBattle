import { LIMITS } from './limits';
import type { AnswerDraft } from './answer-draft';
import type { AttemptData } from './client';
export class SubmissionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}
export async function sendAnswer(
  attemptId: string,
  key: string,
  draft: AnswerDraft,
): Promise<AttemptData> {
  if (draft.photoExpected && !draft.photo)
    throw new SubmissionError(
      'missing-photo',
      'Фото не сохранилось. Прикрепите его снова или выберите «Отправить без фото».',
    );
  const form = new FormData();
  form.set('payload', JSON.stringify(draft.payload));
  if (draft.photo) form.set('solution', draft.photo, draft.photo.name || 'solution.jpg');
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), LIMITS.uploadTimeoutMs);
  try {
    const r = await fetch('/api/attempts/' + attemptId + '/answers', {
      method: 'POST',
      headers: { 'x-attempt-key': key },
      body: form,
      signal: controller.signal,
    });
    const data = (await r.json().catch(() => null)) as
      | (AttemptData & { code?: string; error?: string })
      | null;
    if (!r.ok)
      throw new SubmissionError(
        data?.code || (r.status === 413 ? 'size' : r.status === 415 ? 'format' : 'save'),
        data?.error ||
          (r.status === 413
            ? 'Файл слишком большой. Замените фото на меньший снимок.'
            : r.status === 415
              ? 'Формат не поддерживается. Выберите JPEG, PNG или WebP.'
              : draft.photo
                ? 'Не удалось загрузить фото. Повторите отправку.'
                : 'Не удалось сохранить ответ. Повторите отправку.'),
        r.status,
      );
    if (!data?.attemptId)
      throw new SubmissionError('confirmation', 'Подтверждение не получено. Повторите отправку.');
    return data;
  } catch (e) {
    if (e instanceof SubmissionError) throw e;
    if (controller.signal.aborted)
      throw new SubmissionError('timeout', 'Подтверждение не получено. Повторите отправку.');
    throw new SubmissionError(
      'network',
      'Нет соединения. Проверьте интернет и повторите отправку.',
    );
  } finally {
    clearTimeout(timeout);
  }
}
