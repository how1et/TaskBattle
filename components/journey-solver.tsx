'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Hourglass, ImagePlus, Pencil, Trash2 } from 'lucide-react';
import { api, duration, readLocal, writeLocal, type AttemptData } from '@/lib/client';
import { flushDrafts, readDraft, saveDraft } from '@/lib/answer-draft';
import { freezeVisit, visitTime, type JourneyDraft, type VisitClock } from '@/lib/journey-draft';
import { preparePhoto } from '@/lib/photo-preparation';
import { LIMITS } from '@/lib/limits';
import { usePhotos } from './use-photos';
import { Photo } from './quest-presentation';
import { Input } from './ui/input';
import { Button } from './ui/button';
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

/** All asynchronous work stays attached to a stable task id. A single queue owns the visit. */
export function JourneySolver({
  a,
  secret,
  accept,
}: {
  a: AttemptData;
  secret: string;
  accept: (a: AttemptData) => void;
}) {
  const [data, setData] = useState(a),
    state = useRef(a);
  const [selected, setSelected] = useState(a.journey!.selected),
    selectedRef = useRef(selected);
  const [drafts, setDrafts] = useState<Record<string, JourneyDraft>>({}),
    draftRef = useRef(drafts);
  const [phase, setPhase] = useState('restoring'),
    [error, setError] = useState(''),
    [warning, setWarning] = useState('');
  const [preview, setPreview] = useState(''),
    [tick, setTick] = useState(0);
  const [clockView, setClockView] = useState({ ms: 0, taskId: '' });
  const [finishPending, setFinishPending] = useState(false);
  const owner = useRef(''),
    clock = useRef<VisitClock | null>(null),
    busy = useRef(false),
    alive = useRef(true),
    epoch = useRef(0),
    desired = useRef<string | null>(null);
  const beginId = useRef<string | null>(null),
    finishId = useRef<string | null>(null);
  const photoOpening = useRef<Promise<void>>(Promise.resolve());
  const photoTask = useRef<string | null>(null);
  const key = `journey:${a.attemptId}`,
    task = data.tasks.find((t) => t.id === selected)!;
  const current = drafts[selected],
    accepted = data.journey!.accepted[selected];
  const solutionPath = current?.photoAction === 'keep' ? accepted?.solutionPhoto : null;
  const photoList = [
    { id: task.id, path: task.photo },
    ...data.tasks
      .filter((t) => t.id !== task.id)
      .slice(0, 2)
      .map((t) => ({ id: t.id, path: t.photo })),
    ...(solutionPath ? [{ id: 'solution-' + selected, path: solutionPath }] : []),
  ];
  const { photos, error: photoError, retry } = usePhotos(photoList, secret);
  const loaded = !!photos[task.id],
    photoReady = useRef(loaded);
  useEffect(() => {
    photoReady.current = loaded;
  }, [loaded]);
  const locked =
    phase === 'restoring' ||
    phase === 'sending' ||
    phase === 'moving' ||
    phase === 'preparing' ||
    phase === 'finishing' ||
    phase === 'opening-photo' ||
    phase === 'checking';
  function update(next: AttemptData) {
    if (
      (state.current.finishedAt !== null && next.finishedAt === null) ||
      (next.journey && next.journey.version < state.current.journey!.version)
    )
      return;
    state.current = next;
    setData(next);
    if (next.finishedAt !== null) {
      clock.current = null;
      writeLocal(key + ':clock', null);
      accept(next);
    }
  }
  function save(d: JourneyDraft, urgent = false) {
    draftRef.current = { ...draftRef.current, [d.id.split(':').at(-1)!]: d };
    setDrafts(draftRef.current);
    void saveDraft(d, urgent).then((w) => {
      if (w && alive.current) setWarning(w);
    });
  }
  function clockSave() {
    writeLocal(key + ':clock', clock.current);
  }
  function freeze() {
    clock.current = freezeVisit(clock.current);
    clockSave();
    setTick((t) => t + 1);
    setClockView({ ms: visitTime(clock.current), taskId: clock.current?.taskId || '' });
  }
  async function control(body: Record<string, unknown>) {
    const next = await api<AttemptData>(`/attempts/${a.attemptId}/journey`, secret, false, {
      ...body,
      owner: owner.current,
    });
    update(next);
    return next;
  }
  async function refresh() {
    const next = await api<AttemptData>(`/attempts/${a.attemptId}/journey`, secret);
    update(next);
    return next;
  }
  function problem(e: unknown) {
    if (alive.current) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие. Повторите.');
      setPhase('error');
    }
  }
  async function close() {
    if (!clock.current) return;
    freeze();
    const frozen = clock.current!;
    await control({ action: 'close', id: frozen.id, durationMs: frozen.elapsed });
    clock.current = null;
    setClockView({ ms: 0, taskId: '' });
    clockSave();
    beginId.current = null;
  }
  async function begin() {
    if (!alive.current || state.current.finishedAt !== null) return;
    if (!photoReady.current) {
      setPhase('ready');
      return;
    }
    if (clock.current) {
      setPhase(clock.current.start === null ? 'error' : 'editing');
      if (clock.current.start === null)
        setError('Действие ещё не подтверждено. Проверьте состояние и продолжите.');
      return;
    }
    let active = state.current.journey!.visit;
    if (active?.owner === 'legacy') {
      await control({ action: 'adopt-legacy' });
      active = state.current.journey!.visit;
    }
    if (active) {
      if (active.owner !== owner.current) {
        setPhase('other');
        return;
      }
      if (active.taskId !== selectedRef.current) {
        selectedRef.current = active.taskId;
        setSelected(active.taskId);
        setPhase('ready');
        return;
      }
      const remembered = readLocal<VisitClock>(key + ':clock');
      clock.current =
        remembered?.id === active.id
          ? remembered
          : {
              id: active.id,
              taskId: active.taskId,
              start:
                active.startedAt === null
                  ? // This branch runs in the asynchronous visit effect, never in render.
                    // eslint-disable-next-line react-hooks/purity
                    Date.now()
                  : active.startedAt - (state.current.clockOffset || 0),
              elapsed: 0,
            };
      if (clock.current.start === null) {
        setPhase('error');
        setError('Есть незавершённое действие. Повторите отправку или проверьте состояние.');
        return;
      }
      clockSave();
      setPhase('editing');
      return;
    }
    beginId.current ||= crypto.randomUUID();
    const next = await control({
      action: 'begin',
      id: beginId.current,
      taskId: selectedRef.current,
      version: state.current.journey!.version,
    });
    if (next.finishedAt !== null) return;
    clock.current = {
      id: beginId.current,
      taskId: selectedRef.current,
      // Read only after the begin request resolves.
      // eslint-disable-next-line react-hooks/purity
      start: Date.now(),
      elapsed: 0,
    };
    clockSave();
    void control({
      action: 'arm',
      id: beginId.current,
      // eslint-disable-next-line react-hooks/purity
      startedAt: Math.round(Date.now() + (next.clockOffset || 0)),
    }).catch(() => {});
    setPhase('editing');
  }
  async function run(work: () => Promise<void>, phaseName: string) {
    if (busy.current) return;
    busy.current = true;
    setPhase(phaseName);
    setError('');
    try {
      await work();
    } catch (e) {
      desired.current = null;
      problem(e);
    } finally {
      busy.current = false;
      if (desired.current && alive.current) {
        const target = desired.current;
        desired.current = null;
        queueMicrotask(() => void navigate(target));
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    owner.current = readLocal<string>(key + ':owner') || crypto.randomUUID();
    writeLocal(key + ':owner', owner.current);
    finishId.current = readLocal<string>(key + ':finish');
    queueMicrotask(() => setFinishPending(!!finishId.current));
    void (async () => {
      const restored: Record<string, JourneyDraft> = {};
      for (const t of a.tasks) {
        const id = key + ':' + t.id,
          read = await readDraft(id),
          saved = read.draft as JourneyDraft | undefined,
          accepted = a.journey!.accepted[t.id];
        const legacy =
          !saved && !accepted
            ? (await readDraft(`answer:${a.attemptId}:${a.journey!.legacySlots[t.id]}`)).draft
            : undefined;
        const migrated = legacy
          ? {
              ...legacy,
              id,
              revision: 0,
              dirty: !!legacy.answer || !!legacy.photo,
              photoAction:
                legacy.photoExpected || legacy.photo ? ('replace' as const) : ('remove' as const),
            }
          : undefined;
        if (legacy && a.journey!.visit?.taskId === t.id && a.journey!.visit.owner === 'legacy') {
          const elapsed = legacy.payload?.durationMs ?? legacy.resume?.elapsedMs ?? 0;
          writeLocal(key + ':clock', {
            id: a.journey!.visit.id,
            taskId: t.id,
            start: legacy.payload
              ? null
              : (legacy.resume?.wallStartedAt ?? legacy.activation?.wallStartedAt ?? Date.now()),
            elapsed,
          });
        }
        restored[t.id] = (saved?.dirty ||
        saved?.operation ||
        saved?.revision === (accepted?.revision || 0)
          ? saved
          : undefined) ||
          migrated || {
            id,
            position: t.ordinal - 1,
            answer: accepted?.answer || '',
            photo: null,
            photoAction: accepted?.solutionPhoto ? 'keep' : 'remove',
            revision: accepted?.revision || 0,
            dirty: false,
          };
        if (read.warning) setWarning(read.warning);
      }
      if (!alive.current) return;
      draftRef.current = restored;
      setDrafts(restored);
      const local = readLocal<VisitClock>(key + ':clock');
      if (local && local.id === a.journey!.visit?.id && a.journey!.visit?.owner !== 'legacy')
        clock.current = local;
      if (finishId.current) {
        setPhase('error');
        setError('Завершение ещё не подтверждено. Повторите его.');
      } else if (restored[selectedRef.current]?.operation) {
        setPhase('error');
        setError('Отправка ещё не подтверждена. Повторите её или проверьте состояние.');
      } else if (clock.current?.start !== null && clock.current) {
        setPhase('editing');
      } else if (clock.current) {
        setPhase('error');
        setError('Действие ещё не подтверждено. Проверьте состояние и продолжите.');
      } else setPhase('ready');
    })();
    const timer = setInterval(() => {
      if (alive.current) {
        setTick((t) => t + 1);
        setClockView({ ms: visitTime(clock.current), taskId: clock.current?.taskId || '' });
      }
    }, 100);
    const checkpoint = setInterval(() => {
      const c = clock.current;
      if (c?.start !== null && c && !busy.current)
        void api('/attempts/' + a.attemptId + '/journey', secret, false, {
          action: 'checkpoint',
          owner: owner.current,
          id: c.id,
          durationMs: visitTime(c),
        }).catch(() => {});
    }, 5000);
    const hide = () => {
      clockSave();
      flushDrafts();
    };
    window.addEventListener('pagehide', hide);
    return () => {
      alive.current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      clearInterval(timer);
      clearInterval(checkpoint);
      window.removeEventListener('pagehide', hide);
      hide();
    };
    // The component owns one attempt; state is synchronized through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (phase === 'ready' && loaded && !busy.current) void run(begin, 'moving');
  }, [phase, loaded, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!current?.photo) {
      // Object URLs belong to the currently selected File, synchronized with browser resource cleanup.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(current.photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [current?.photo]);
  useEffect(() => {
    if (
      // Calendar check runs in this effect after the timer tick.
      // eslint-disable-next-line react-hooks/purity
      Date.now() + (data.clockOffset || 0) >= data.deadlineAt &&
      !busy.current &&
      data.finishedAt === null
    ) {
      freeze();
      void run(async () => {
        await refresh();
      }, 'finishing');
    }
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  async function reconcile() {
    freeze();
    const d = draftRef.current[selectedRef.current];
    if (d?.operation) {
      const next = await control({ action: 'cancel', requestId: d.operation.requestId });
      const accepted = next.journey!.accepted[selectedRef.current];
      // The cancellation fence settles even an upload still running on the server.
      save(
        {
          ...d,
          operation: undefined,
          revision: accepted?.revision || 0,
          dirty: d.answer !== (accepted?.answer || '') || d.photoAction !== 'keep',
        },
        true,
      );
    } else await refresh();
    const visit = state.current.journey!.visit;
    if (clock.current && visit?.id === clock.current.id) await close();
    else {
      clock.current = null;
      clockSave();
    }
    beginId.current = null;
  }
  async function navigate(id: string) {
    desired.current = id;
    if (busy.current) return;
    await run(async () => {
      if (draftRef.current[selectedRef.current]?.operation) await reconcile();
      await close();
      epoch.current++;
      const target = desired.current!;
      desired.current = null;
      selectedRef.current = target;
      setSelected(target);
      setPhase('ready');
    }, 'moving');
  }
  function change(answer: string) {
    const d = draftRef.current[selectedRef.current];
    if (!d) return;
    save({ ...d, answer, dirty: true });
    if (phase === 'accepted') setPhase('ready');
  }
  async function selectPhoto(file: File | null) {
    await run(async () => {
      if (draftRef.current[selectedRef.current]?.operation) await reconcile();
      await close();
      const taskId = selectedRef.current,
        stamp = ++epoch.current;
      const prepared = file ? await preparePhoto(file) : null;
      if (!alive.current || stamp !== epoch.current) return;
      const d = draftRef.current[taskId];
      save(
        {
          ...d,
          photo: prepared,
          photoId: prepared ? crypto.randomUUID() : undefined,
          photoExpected: !!prepared,
          photoAction: prepared ? 'replace' : 'remove',
          dirty: true,
        },
        true,
      );
      setPhase('ready');
    }, 'preparing');
    // A processing error retains the previous attachment and leaves recovery controls available.
  }
  function beginPhotoSelection() {
    photoTask.current = selectedRef.current;
    if (phase !== 'error' && phase !== 'accepted') return;
    photoOpening.current = run(async () => {
      await reconcile();
      await begin();
    }, 'opening-photo');
  }
  async function submit(without = false) {
    await run(async () => {
      const id = selectedRef.current;
      let d = draftRef.current[id];
      if (!d?.answer.trim()) {
        setPhase('editing');
        return;
      }
      if (without) {
        await reconcile();
        d = {
          ...draftRef.current[id],
          photo: null,
          photoExpected: false,
          photoAction: 'remove',
          dirty: true,
        };
        save(d, true);
      }
      if (d.photoExpected && !d.photo)
        throw Error('Фото не сохранилось. Прикрепите его снова или выберите «Отправить без фото».');
      if (!d.operation) {
        await close();
        d = {
          ...d,
          operation: {
            requestId: crypto.randomUUID(),
            taskId: id,
            version: state.current.journey!.version,
            revision: d.revision || 0,
            answer: d.answer.trim(),
            photoAction: d.photoAction || 'remove',
          },
        };
        save(d, true);
      }
      const form = new FormData();
      form.set('payload', JSON.stringify(d.operation));
      if (d.operation!.photoAction === 'replace' && d.photo) form.set('solution', d.photo);
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), LIMITS.uploadTimeoutMs);
      let next: AttemptData;
      try {
        const response = await fetch(`/api/attempts/${a.attemptId}/journey-answer`, {
          method: 'POST',
          headers: { 'x-attempt-key': secret },
          body: form,
          signal: controller.signal,
        });
        const out = (await response.json()) as AttemptData & { error?: string };
        if (!response.ok)
          throw Error(out.error || 'Не удалось сохранить ответ. Повторите отправку.');
        next = out;
      } catch (e) {
        if (e instanceof TypeError || controller.signal.aborted)
          throw Error('Связь прервалась. Повторите отправку или проверьте состояние.');
        throw e;
      } finally {
        clearTimeout(timeout);
      }
      update(next);
      const stored = next.journey!.accepted[id];
      if (stored)
        save(
          {
            ...d,
            answer: stored.answer,
            operation: undefined,
            revision: stored.revision,
            photo: null,
            photoExpected: false,
            photoAction: stored.solutionPhoto ? 'keep' : 'remove',
            dirty: false,
          },
          true,
        );
      setPhase('accepted');
    }, 'sending');
  }
  async function finish() {
    await run(async () => {
      if (draftRef.current[selectedRef.current]?.operation) await reconcile();
      await close();
      finishId.current ||= crypto.randomUUID();
      writeLocal(key + ':finish', finishId.current);
      setFinishPending(true);
      try {
        await control({
          action: 'finish',
          requestId: finishId.current,
          version: state.current.journey!.version,
        });
      } catch (e) {
        if (e instanceof Error && 'status' in e && e.status === 409) {
          finishId.current = null;
          setFinishPending(false);
          writeLocal(key + ':finish', null);
          await refresh();
        }
        throw e;
      }
    }, 'finishing');
  }
  const total = data.completedMs + clockView.ms;
  const taskTime =
    (data.journey!.times[selected] || 0) + (clockView.taskId === selected ? clockView.ms : 0);
  const draftCount = Object.values(drafts).filter((d) => d.dirty || d.operation).length;
  const canEdit =
    (!locked || phase === 'moving') &&
    !current?.operation &&
    ['editing', 'accepted', 'ready', 'moving'].includes(phase) &&
    !finishPending;
  return (
    <div className="panel page-card solve-card">
      <div className="row spread solve-heading">
        <div>
          <p className="eyebrow">{data.title}</p>
          <h2>
            Задача {task.ordinal} из {data.count}
          </h2>
          <p className="small muted">
            Отправлено: {Object.keys(data.journey!.accepted).length} из {data.count}
          </p>
        </div>
        <div className="timer-box">
          <Hourglass size={23} />
          <div>
            <small>Общее время</small>
            <strong>{duration(total)}</strong>
            <small>Эта задача: {duration(taskTime)}</small>
          </div>
        </div>
      </div>
      <nav className="task-navigation" aria-label="Навигация по задачам">
        {data.tasks.map((t) => {
          const d = drafts[t.id],
            sent = !!data.journey!.accepted[t.id],
            dirty = !!d?.dirty;
          return (
            <button
              type="button"
              key={t.id}
              aria-current={selected === t.id ? 'step' : undefined}
              aria-label={`Задача ${t.ordinal}: ${dirty ? 'черновик' : sent ? 'ответ отправлен' : 'без ответа'}`}
              className={`task-number ${selected === t.id ? 'current' : ''} ${dirty ? 'draft' : sent ? 'submitted' : ''}`}
              disabled={
                phase === 'restoring' ||
                phase === 'sending' ||
                phase === 'finishing' ||
                phase === 'preparing' ||
                finishPending
              }
              onClick={() => void navigate(t.id)}
            >
              <span>{t.ordinal}</span>
              {dirty ? (
                <Pencil size={13} />
              ) : sent ? (
                <Check size={14} />
              ) : (
                <span className="small">·</span>
              )}
            </button>
          );
        })}
      </nav>
      <p className="small muted nav-legend">
        <Pencil size={13} /> Черновик <Check size={14} /> Ответ отправлен
      </p>
      {loaded ? (
        <Photo src={photos[task.id]} label={'Задача ' + task.ordinal} />
      ) : (
        <p role="status">Загружаем задачу…</p>
      )}
      {photoError && (
        <div className="error">
          {photoError}
          <Button className="secondary" onClick={retry}>
            Повторить загрузку
          </Button>
        </div>
      )}
      {phase === 'other' && (
        <div className="notice">
          Попытка открыта в другой вкладке.
          <Button
            className="secondary"
            onClick={() =>
              void run(async () => {
                await control({ action: 'takeover', version: state.current.journey!.version });
                clock.current = null;
                beginId.current = null;
                setPhase('ready');
              }, 'checking')
            }
          >
            Продолжить здесь
          </Button>
        </div>
      )}
      {(phase === 'accepted' || (accepted && !current?.dirty)) && (
        <p role="status" className="notice">
          Ответ отправлен. Можно выбрать другую задачу или исправить ответ.
        </p>
      )}
      {current?.dirty && accepted && (
        <p className="notice small">
          Изменения ещё не отправлены. В итог попадёт предыдущий принятый ответ.
        </p>
      )}
      <div className="solution-attachment">
        {(preview || photos['solution-' + selected]) && (
          <div className="solution-preview">
            <img src={preview || photos['solution-' + selected]} alt="Фото вашего решения" />
            <span>{current?.photo ? 'Фото выбрано' : 'Фото отправлено'}</span>
            <Button
              type="button"
              variant="ghost"
              className="icon-button"
              aria-label="Удалить фото решения"
              disabled={locked || phase === 'other' || finishPending}
              onClick={() => void selectPhoto(null)}
            >
              <Trash2 size={18} />
            </Button>
          </div>
        )}
        <div className="solution-actions">
          {[false, true].map((camera) => (
            <label key={String(camera)} className={'photo-choice ' + (locked ? 'disabled' : '')}>
              {camera ? <Camera size={18} /> : <ImagePlus size={18} />}{' '}
              {camera
                ? 'Камера'
                : preview || solutionPath
                  ? 'Заменить фото'
                  : 'Добавить фото решения'}
              <input
                type="file"
                accept="image/*"
                capture={camera ? 'environment' : undefined}
                aria-label={
                  camera ? 'Снять фото решения камерой' : 'Добавить или заменить фото решения'
                }
                disabled={
                  (locked && phase !== 'opening-photo') || phase === 'other' || finishPending
                }
                onClick={beginPhotoSelection}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  const target = photoTask.current;
                  if (file)
                    void photoOpening.current.then(() => {
                      if (alive.current && selectedRef.current === target) return selectPhoto(file);
                    });
                }}
              />
            </label>
          ))}
        </div>
        <span className="small muted">
          Необязательно · JPEG, PNG, WebP · до 30 МБ · большие фото уменьшим
        </span>
      </div>
      {warning && <p className="notice small">{warning}</p>}
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <div className="row recovery-actions">
            {finishPending ? (
              <Button className="secondary" disabled={locked} onClick={() => void finish()}>
                Повторить завершение
              </Button>
            ) : (
              <>
                <Button
                  className="secondary"
                  disabled={locked}
                  onClick={() =>
                    void run(async () => {
                      await reconcile();
                      setPhase('ready');
                    }, 'checking')
                  }
                >
                  Проверить состояние и продолжить
                </Button>
                {(current?.photo || current?.photoExpected || solutionPath) && (
                  <Button
                    className="secondary"
                    disabled={locked || !current?.answer.trim()}
                    onClick={() => void submit(true)}
                  >
                    Отправить без фото
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      <form
        className="answer-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          className="text-input"
          aria-label="Ваш ответ"
          placeholder="Ваш ответ"
          value={current?.answer || ''}
          onChange={(e) => change(e.target.value)}
          onFocus={() => {
            if (phase === 'accepted') setPhase('ready');
          }}
          disabled={!canEdit || !loaded}
          maxLength={200}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
        />
        <Button
          type="submit"
          className="primary"
          disabled={
            locked || !current?.answer.trim() || !loaded || phase === 'other' || finishPending
          }
        >
          {phase === 'sending'
            ? 'Сохраняем ответ…'
            : current?.operation
              ? 'Повторить отправку'
              : accepted
                ? 'Обновить ответ'
                : 'Ответить'}
        </Button>
      </form>
      {['moving', 'preparing', 'checking', 'finishing'].includes(phase) && (
        <p role="status">
          {phase === 'preparing'
            ? 'Готовим фото…'
            : phase === 'finishing'
              ? 'Сохраняем итог…'
              : 'Подготавливаем задачу…'}
        </p>
      )}
      <div className="finish-area">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              className="secondary"
              variant="outline"
              disabled={locked || phase === 'other' || finishPending}
            >
              Закончить тест
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Закончить тест?</AlertDialogTitle>
            <AlertDialogDescription>
              Отправлено ответов: {Object.keys(data.journey!.accepted).length} из {data.count}. В
              отчёт войдут только принятые ответы.
            </AlertDialogDescription>
            {draftCount > 0 && (
              <p className="notice">
                Неотправленных черновиков: {draftCount}. Текст и фото из этих изменений не войдут в
                результат.
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel className="secondary">Продолжить решать</AlertDialogCancel>
              <AlertDialogAction className="primary" onClick={() => void finish()}>
                Закончить тест
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
