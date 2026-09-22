'use client';
import { SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { date, duration, type AttemptData } from '@/lib/client';
import {
  Check,
  CircleCheck,
  CircleMinus,
  Copy,
  Gauge,
  Hourglass,
  LockKeyhole,
  Mail,
  Maximize2,
  Timer,
} from 'lucide-react';
import { memo, useState } from 'react';
import { ReportPhoto } from './report-photo';

export function Frame({ children, focus = false }: { children: React.ReactNode; focus?: boolean }) {
  return (
    <>
      <SiteHeader />
      <main className={'workspace ' + (focus ? 'battle-workspace' : '')}>
        <div className="content-narrow">{children}</div>
      </main>
    </>
  );
}

export const Photo = memo(function Photo({
  src,
  label,
  small = false,
}: {
  src: string;
  label: string;
  small?: boolean;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <button
        className="image-button"
        type="button"
        onClick={() => setZoom(true)}
        aria-label={'Увеличить: ' + label}
      >
        <img
          src={src}
          alt={label}
          loading={small ? 'lazy' : 'eager'}
          style={small ? { height: 220 } : undefined}
        />
        <span className="photo-caption">
          <Maximize2 size={14} />
          Увеличить фотографию
        </span>
      </button>
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="zoom-content" showCloseButton={false}>
          <div className="row spread">
            <DialogTitle>{label}</DialogTitle>
            <DialogClose asChild>
              <Button className="secondary" variant="outline">
                Закрыть
              </Button>
            </DialogClose>
          </div>
          <DialogDescription>Разведите два пальца, чтобы приблизить фотографию.</DialogDescription>
          <img src={src} alt={label} />
        </DialogContent>
      </Dialog>
    </>
  );
});

export function Share({
  title,
  value,
  secret = false,
}: {
  title: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <div className={'copy-box ' + (secret ? 'secret-box' : '')}>
      <h3 className="row">
        {secret ? <LockKeyhole size={20} /> : <Mail size={20} />} {title}
      </h3>
      <p className="muted small">
        {secret
          ? 'Сохраните её для просмотра результатов. Не отправляйте ученику.'
          : 'Отправьте ученику, чтобы начать занятие.'}
      </p>
      <Input
        className="text-input"
        readOnly
        aria-label={title}
        value={value}
        onFocus={(e) => e.target.select()}
      />
      <Button
        className="secondary"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}{' '}
        {copied
          ? 'Ссылка скопирована'
          : secret
            ? 'Скопировать секретную ссылку'
            : 'Скопировать ссылку'}
      </Button>
      {failed && <p className="small muted">Выделите ссылку в поле и скопируйте вручную.</p>}
    </div>
  );
}

export function Report({
  data,
  secret,
  teacher,
}: {
  data: AttemptData;
  secret: string;
  teacher: boolean;
}) {
  const s = data.summary!;
  const mentorMessage =
    s.correct === s.count
      ? 'Без единой ошибки! Испытание пройдено.'
      : s.correct / s.count < 0.5
        ? 'Испытание завершено. Разберём задачи — и можно попробовать снова.'
        : `Верных ответов: ${s.correct} из ${s.count}. Давай разберём остальные задачи.`;
  return (
    <div className="stack report-layout">
      <section className="result-scene" aria-label="Итоги попытки">
        <div className="result-heading">
          <p className="eyebrow">{data.title}</p>
          <h1>Испытание завершено</h1>
          {data.finishReason === 'manual' && <p className="notice">Тест завершён досрочно</p>}
          {data.finishReason === 'timeout' && (
            <p className="notice">Попытка завершена: прошло 24 часа</p>
          )}
          <p className="result-date">Начало: {date(data.startedAt)}</p>
        </div>
        <div className="mentor-scene">
          <img
            className="character-art mentor-art"
            src="/images/wizard-mentor.webp"
            width="640"
            height="640"
            alt="Волшебник-наставник с книгой"
          />
          <div className="mentor-message">
            <span className="mentor-label">НАСТАВНИК</span>
            <p>{mentorMessage}</p>
          </div>
        </div>
        <div className="result-numbers">
          <div className="score-stat">
            <CircleCheck size={24} />
            <span>Правильных ответов</span>
            <strong>
              {s.correct}
              <span> / {s.count}</span>
            </strong>
          </div>
          <div className="time-stats">
            <div className="time-stat">
              <Hourglass size={20} />
              <span>Общее время</span>
              <strong>{duration(s.totalMs)}</strong>
            </div>
            <div className="time-stat">
              <Timer size={20} />
              <span>В среднем на задачу</span>
              <strong>{s.averageMs === null ? '—' : duration(s.averageMs)}</strong>
            </div>
          </div>
        </div>
        <div className="partial-stats">
          <span>
            Отправлено:{' '}
            <b>
              {s.submitted} из {s.count}
            </b>
          </span>
          <span>
            Неверно: <b>{s.wrong}</b>
          </span>
          <span>
            Не решено: <b>{s.unsolved}</b>
          </span>
        </div>
        {data.timingIncomplete && (
          <p className="notice small">
            Время незавершённой задачи не удалось восстановить. Общее время включает только
            сохранённые интервалы решения.
          </p>
        )}
        {data.unfinishedMs > 0 && (
          <p className="small muted">
            В общем времени учтена незавершённая задача: {duration(data.unfinishedMs)}. Среднее — по
            отправленным ответам.
          </p>
        )}
        <div className="extrema">
          <div>
            <Gauge size={20} />
            <div>
              <strong>Быстрее всего</strong>
              <p>
                {s.fastest
                  ? `№ ${s.fastest.ordinals.join(', ')} · ${duration(s.fastest.durationMs)}`
                  : '—'}
              </p>
            </div>
          </div>
          <div>
            <Hourglass size={20} />
            <div>
              <strong>Больше всего времени</strong>
              <p>
                {s.slowest
                  ? `№ ${s.slowest.ordinals.join(', ')} · ${duration(s.slowest.durationMs)}`
                  : '—'}
              </p>
            </div>
          </div>
        </div>
      </section>
      <div className="report-intro">
        <h2>Разбор задач</h2>
        <span className="muted small">Номера в исходном наборе</span>
      </div>
      {data.report!.map((t) => (
        <article className="panel report-task stack" key={t.id}>
          <div className="row spread">
            <h3>Задача № {t.ordinal}</h3>
            <span
              className={
                'status ' + (t.correct === null ? 'unsolved' : t.correct ? 'correct' : 'wrong')
              }
            >
              {t.correct ? <CircleCheck size={15} /> : <CircleMinus size={15} />}{' '}
              {t.correct === null ? 'Не решено' : t.correct ? 'Верно' : 'Неверно'}
            </span>
          </div>
          <ReportPhoto
            path={t.photo}
            secret={secret}
            teacher={teacher}
            label={'Задача № ' + t.ordinal}
          />
          <dl className="answer-grid">
            <div>
              <dt>Ответ ученика</dt>
              <dd>{t.answer ?? '—'}</dd>
            </div>
            <div>
              <dt>Правильный ответ</dt>
              <dd>{t.correctAnswer}</dd>
            </div>
            <div>
              <dt>Время решения</dt>
              <dd>{t.durationMs === null ? '—' : duration(t.durationMs)}</dd>
            </div>
          </dl>
          {t.solutionPhoto && (
            <div className="report-solution">
              <h4>Фото решения</h4>
              <ReportPhoto
                path={t.solutionPhoto}
                secret={secret}
                teacher={teacher}
                label={'Решение задачи № ' + t.ordinal}
              />
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
