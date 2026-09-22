'use client';
import { LIMITS } from '@/lib/limits';
import { type AttemptData } from '@/lib/client';
import { ArrowRight, Camera, Check, Gem, Hourglass, ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Photo } from './quest-presentation';
import { SolverTimer } from './solver-timer';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { Skeleton } from './ui/skeleton';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';
import { useSolver } from './use-solver';
export function AttemptSolver({
  a,
  secret,
  photos,
  accept,
  onError,
  common,
}: {
  a: AttemptData;
  secret: string;
  photos: Record<string, string>;
  accept: (a: AttemptData) => void;
  onError: (e: unknown) => void;
  common: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null),
    gallery = useRef<HTMLInputElement>(null);
  const solver = useSolver(a, secret, !!photos[a.tasks[a.position]?.id], accept, onError);
  const busy = solver.busy || solver.finishPending,
    answer = solver.answer,
    pending = solver.pending;
  useEffect(() => {
    if (!solver.preparing) input.current?.focus();
  }, [solver.preparing]);
  const task = a.tasks[a.position];
  return (
    <>
      <div className="panel page-card solve-card">
        <div className="row spread solve-heading">
          <div>
            <p className="eyebrow">{a.title}</p>
            <h2>
              Задача {a.position + 1} из {a.count}
            </h2>
          </div>
          <div className="timer-box">
            <Hourglass size={23} />
            <div>
              <small>Общее время</small>
              <SolverTimer completedMs={a.completedMs} readTime={solver.readTime} />
            </div>
          </div>
        </div>
        <div className="progress-area">
          <Progress
            className="progress-line"
            value={(a.position / a.count) * 100}
            aria-label="Прогресс попытки"
          />
          <div className="rune-track" aria-hidden="true">
            {a.tasks.map((t, i) => (
              <span
                key={t.id}
                className={
                  'rune ' + (i < a.position ? 'complete' : i === a.position ? 'current' : '')
                }
              >
                {i < a.position ? (
                  <Check size={13} />
                ) : i === a.position ? (
                  <Gem size={15} />
                ) : (
                  i + 1
                )}
              </span>
            ))}
          </div>
        </div>
        {photos[task.id] ? (
          <Photo src={photos[task.id]} label={'Задача ' + (a.position + 1)} />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
        <div className="solution-attachment">
          {solver.preview && (
            <div className="solution-preview">
              <img src={solver.preview} alt="Фото вашего решения" />
              <span>Фото выбрано</span>
              <Button
                type="button"
                variant="ghost"
                className="icon-button"
                aria-label="Удалить фото решения"
                disabled={busy}
                onClick={() => void solver.selectPhoto(null)}
              >
                <Trash2 size={18} />
              </Button>
            </div>
          )}
          <div className="solution-actions">
            <label className={'photo-choice ' + (busy ? 'disabled' : '')}>
              <ImagePlus size={18} />
              {solver.preview ? 'Заменить фото' : 'Добавить фото решения'}
              <input
                ref={gallery}
                type="file"
                accept="image/*"
                aria-label={solver.preview ? 'Заменить фото решения' : 'Добавить фото решения'}
                disabled={busy || solver.preparing}
                onClick={() => {
                  if (pending) void solver.edit();
                }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void solver.selectPhoto(f);
                  e.target.value = '';
                }}
              />
            </label>
            <label className={'photo-choice ' + (busy ? 'disabled' : '')}>
              <Camera size={18} />
              Камера
              <input
                type="file"
                accept="image/*"
                capture="environment"
                aria-label="Снять фото решения камерой"
                disabled={busy || solver.preparing}
                onClick={() => {
                  if (pending) void solver.edit();
                }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void solver.selectPhoto(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <span className="small muted">
            Необязательно · JPEG, PNG, WebP · до 30 МБ · большие фото уменьшим
          </span>
          {solver.photoBusy && <p role="status">Готовим фото…</p>}
        </div>
        {solver.warning && (
          <p role="status" className="notice small">
            {solver.warning}
          </p>
        )}
        {solver.error && (
          <div className="error" role="alert">
            <p>{solver.error}</p>
            <div className="row recovery-actions">
              {solver.finishPending ? (
                <Button
                  type="button"
                  className="secondary"
                  disabled={solver.finishing}
                  onClick={() => void solver.finish()}
                >
                  Повторить
                </Button>
              ) : (
                pending && (
                  <Button
                    type="button"
                    variant="outline"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void solver.edit()}
                  >
                    Изменить ответ
                  </Button>
                )
              )}
              {!solver.finishPending && (solver.preview || solver.missingPhoto) && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="secondary"
                    disabled={busy}
                    onClick={() => gallery.current?.click()}
                  >
                    Заменить фото
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="secondary"
                    disabled={busy || solver.photoBusy || !answer.trim()}
                    onClick={() => void solver.withoutPhoto()}
                  >
                    Отправить без фото
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
        <form
          className="answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void solver.submit();
          }}
        >
          <Input
            ref={input}
            className="text-input"
            aria-label="Ваш ответ"
            placeholder="Ваш ответ"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="send"
            maxLength={LIMITS.answerLength}
            value={answer}
            disabled={busy || pending || solver.preparing || !photos[task.id]}
            onChange={(e) => solver.changeAnswer(e.target.value)}
          />
          <Button
            type="submit"
            className="primary"
            disabled={
              busy || solver.photoBusy || solver.preparing || !answer.trim() || !photos[task.id]
            }
          >
            {solver.finishPending
              ? 'Завершаем тест…'
              : busy
                ? solver.recovering
                  ? 'Проверяем ответ…'
                  : solver.preview
                    ? 'Загружаем фото…'
                    : 'Сохраняем ответ…'
                : pending
                  ? 'Повторить отправку'
                  : 'Ответить'}
            <ArrowRight size={19} />
          </Button>
        </form>
        <div className="finish-area">
          {solver.finishPending ? (
            <p role="status">
              {solver.finishing
                ? 'Сохраняем итог… Таймер остановлен.'
                : 'Время зафиксировано. Повторите завершение, когда появится связь.'}
            </p>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="secondary"
                  disabled={solver.restoring}
                >
                  Закончить тест
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>Закончить тест?</AlertDialogTitle>
                <AlertDialogDescription>
                  Отправлено ответов: {a.position} из {a.count}. Оставшиеся задачи будут отмечены
                  как нерешённые.
                </AlertDialogDescription>
                {(answer.trim() || solver.preview || solver.photoBusy || solver.missingPhoto) && (
                  <p className="notice">
                    Неотправленный ответ и выбранное фото не войдут в результат. Чтобы отправить их,
                    нажмите «Продолжить решать».
                  </p>
                )}
                {solver.busy && (
                  <p className="small muted">
                    Отправка уже началась. Если ответ принят, он сохранится в отчёте.
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel className="secondary">Продолжить решать</AlertDialogCancel>
                  <AlertDialogAction className="primary" onClick={() => void solver.finish()}>
                    Закончить тест
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        {common}
      </div>
    </>
  );
}
