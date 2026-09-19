'use client';
import { SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRoomCreator } from '@/components/use-room-creator';
import { LIMITS } from '@/lib/limits';
import { ArrowRight, Check, Hourglass, ShieldCheck, Trash2 } from 'lucide-react';
export default function Home() {
  const {
    title,
    setTitle,
    tasks,
    setTasks,
    error,
    busy,
    preparing,
    progress,
    recovering,
    creation,
    resetCreation,
    checkPending,
    add,
    create,
    removeTask,
  } = useRoomCreator();
  return (
    <>
      <SiteHeader />
      <main className="workspace creator-workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">ПРЕПОДАВАТЕЛЮ</p>
            <h1>Подготовка комнаты</h1>
          </div>
          <div className="duration-tag">
            <Hourglass size={21} />
            <span>
              Комната на <b>48 часов</b>
            </span>
          </div>
        </div>
        <div className="creator-grid">
          <section className="panel editor" aria-label="Подготовка занятия">
            <div className="section-title">
              <span className="step">01</span>
              <h2>Название занятия</h2>
              <span className="muted small">необязательно</span>
            </div>
            <Input
              className="text-input"
              aria-label="Название занятия"
              placeholder="Например, квадратные уравнения"
              maxLength={LIMITS.titleLength}
              value={title}
              onChange={(e) => {
                resetCreation();
                setTitle(e.target.value);
              }}
              disabled={busy}
            />
            <div className="section-title task-title">
              <span className="step">02</span>
              <h2>Задачи</h2>
              <span className="counter">
                {tasks.length} / {LIMITS.tasks}
              </span>
            </div>
            <label
              className={'upload-area ' + (busy ? 'disabled' : '')}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) add(e.dataTransfer.files);
              }}
            >
              <input
                aria-label="Загрузить фотографии задач"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={busy}
                onChange={(e) => {
                  add(e.target.files);
                  e.target.value = '';
                }}
              />
              <img
                className="upload-book"
                src="/images/spellbook.webp"
                width="112"
                height="112"
                alt=""
              />
              <div className="upload-copy">
                <strong>Добавить задачи</strong>
                <span>Выберите фотографии или перетащите сюда</span>
                <small>
                  JPEG, PNG, WebP · исходник до 30 МБ и 60 Мп
                  <br />
                  Фото уменьшим до 3 МБ · до 25 задач и 18 МБ на комнату
                </small>
              </div>
            </label>
            {tasks.length > 0 && (
              <p className="small muted">Ученик увидит задачи в этом порядке.</p>
            )}
            {tasks.length > 0 && (
              <div className="draft-list">
                {tasks.map((task, i) => (
                  <div className="draft-task" key={task.id}>
                    <div className="draft-photo">
                      <img src={task.url} alt={'Задача ' + (i + 1)} />
                      <span>{String(i + 1).padStart(2, '0')}</span>
                    </div>
                    <div className="draft-fields">
                      <label htmlFor={task.id}>Задача {i + 1} · правильный ответ</label>
                      <Input
                        id={task.id}
                        className="text-input"
                        placeholder="Короткий ответ"
                        maxLength={LIMITS.answerLength}
                        value={task.answer}
                        disabled={busy}
                        onChange={(e) => {
                          resetCreation();
                          setTasks((ts) =>
                            ts.map((t) =>
                              t.id === task.id ? { ...t, answer: e.target.value } : t,
                            ),
                          );
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      className="icon-button"
                      aria-label={'Удалить задачу ' + (i + 1)}
                      disabled={busy}
                      onClick={() => removeTask(task.id)}
                    >
                      <Trash2 size={19} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {progress && (
              <p role="status" className="notice">
                {progress}
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {recovering && (
              <Button className="secondary" disabled={busy} onClick={checkPending}>
                Проверить создание
              </Button>
            )}
            <div className="create-footer">
              <span className="muted small row">
                <Check size={16} />
                {tasks.length
                  ? 'Ответы: ' + tasks.filter((t) => t.answer.trim()).length + ' из ' + tasks.length
                  : 'Одна фотография — одна задача'}
              </span>
              <Button
                className="primary"
                disabled={busy || !tasks.length || tasks.some((t) => !t.answer.trim())}
                onClick={create}
              >
                {preparing
                  ? 'Готовим фото…'
                  : busy
                    ? 'Создаём комнату…'
                    : error && creation.current
                      ? 'Повторить создание'
                      : 'Создать комнату'}
                <ArrowRight size={19} />
              </Button>
            </div>
          </section>
          <aside className="sidebar">
            <div className="adventure-card">
              <img
                src="/images/quest-landscape.webp"
                className="adventure-landscape"
                width="768"
                height="512"
                alt="Замок над озером в ночных горах"
              />
            </div>
            <div className="rules-card">
              <h3>
                <ShieldCheck size={20} />
                Правила проверки
              </h3>
              <p>
                Пробелы по краям и регистр не важны. 5, 5.0 и 5,00 — один ответ; − и - равнозначны.
              </p>
              <p>Выражения сравниваются буквально: 1/2 и 0.5 — разные ответы.</p>
            </div>
            <p className="room-lifetime">
              <Hourglass size={18} />
              Комната — 48 часов. Отчёт — 72 часа после завершения.
            </p>
          </aside>
        </div>
      </main>
      <footer className="footer">
        <span>TaskBattle</span>
        <span>Задачи на время</span>
      </footer>
    </>
  );
}
