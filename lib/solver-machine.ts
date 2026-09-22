import type { AnswerDraft, DraftRead } from './answer-draft';
import type { AttemptData } from './client';
import { elapsed, type ClockAnchor } from './time';
import { readFinish, saveFinish, type FinishIntent } from './finish-intent';
export type SolverPhase =
  | 'loading'
  | 'preparing'
  | 'editing'
  | 'sending'
  | 'failed'
  | 'recovering'
  | 'transition'
  | 'finishing'
  | 'finish-failed'
  | 'finished';
export type SolverState = {
  draft: AnswerDraft | null;
  phase: SolverPhase;
  photoBusy: boolean;
  error: string;
  warning: string;
};
export type SolverServices = {
  read: (id: string) => Promise<DraftRead>;
  save: (d: AnswerDraft, urgent?: boolean) => Promise<string | undefined>;
  remove: (id: string) => Promise<void>;
  ready: (a: AttemptData, d: AnswerDraft) => Promise<AttemptData>;
  check: (a: AttemptData) => Promise<AttemptData>;
  cancel: (
    a: AttemptData,
    d: AnswerDraft,
  ) => Promise<{ cancelled: boolean; snapshot: AttemptData }>;
  send: (a: AttemptData, d: AnswerDraft) => Promise<AttemptData>;
  finish: (a: AttemptData, intent: FinishIntent) => Promise<AttemptData>;
  prepare: (file: File, signal?: AbortSignal) => Promise<File>;
  accept: (a: AttemptData) => void;
  changed: (s: SolverState) => void;
  fatal: (e: unknown) => void;
  wall: () => number;
  mono: () => number;
  uuid: () => string;
};
export class SolverMachine {
  state: SolverState = { draft: null, phase: 'loading', photoBusy: false, error: '', warning: '' };
  private clock: ClockAnchor | null = null;
  private frozen = 0;
  private alive = true;
  private photoEpoch = 0;
  private sending = false;
  private finishing = false;
  private finishIntent: FinishIntent | null = null;
  private registering: Promise<AttemptData> | null = null;
  private recovery: Promise<boolean> | null = null;
  readonly id: string;
  private photoController: AbortController | null = null;
  constructor(
    public server: AttemptData,
    private io: SolverServices,
  ) {
    this.id = `answer:${server.attemptId}:${server.position}`;
  }
  dispose() {
    this.alive = false;
    this.photoEpoch++;
    this.photoController?.abort();
  }
  private emit(p: Partial<SolverState> = {}) {
    if (!this.alive) return;
    this.state = { ...this.state, ...p };
    this.io.changed(this.state);
  }
  private get finished() {
    return this.state.phase === 'finished' || this.state.phase === 'transition';
  }
  get time() {
    return this.clock ? elapsed(this.clock, this.io.wall(), this.io.mono()) : this.frozen;
  }
  private startClock(ms: number) {
    this.frozen = ms;
    this.clock = { elapsed: ms, wall: this.io.wall(), mono: this.io.mono() };
  }
  private async persist(urgent = false) {
    const d = this.state.draft;
    if (!d) return;
    try {
      const warning = await this.io.save(d, urgent);
      if (this.alive && warning) this.emit({ warning });
    } catch {
      this.emit({
        warning: 'Черновик доступен только в этой вкладке. Не закрывайте её до отправки.',
      });
    }
  }
  private put(d: AnswerDraft) {
    this.emit({ draft: d });
    void this.persist();
  }
  private error(e: unknown) {
    if (!this.alive) return;
    this.emit({
      error: e instanceof Error ? e.message : 'Не удалось сохранить ответ. Повторите отправку.',
    });
    if (e && typeof e === 'object' && 'status' in e && e.status === 410) this.io.fatal(e);
  }
  private async accepted(out: AttemptData) {
    if (!this.alive) return;
    if (this.finishIntent && out.finishedAt === null) return;
    if (this.finished && out.finishedAt === null) return;
    if (out.finishedAt !== null) saveFinish(this.server.attemptId, null);
    this.frozen = this.state.draft?.payload?.durationMs ?? this.time;
    this.clock = null;
    this.photoEpoch++;
    this.emit({
      phase: out.finishedAt !== null ? 'finished' : 'transition',
      photoBusy: false,
      error: '',
    });
    this.io.accept(out);
    try {
      await this.io.remove(this.id);
    } catch {
      /* Cache cleanup cannot undo an accepted answer. */
    }
  }
  async init() {
    const intent = readFinish(this.server.attemptId);
    if (intent) {
      this.finishIntent = intent;
      this.frozen = intent.position === this.server.position ? intent.durationMs : 0;
      await this.finish();
      return;
    }
    let result: DraftRead = {};
    try {
      result = await this.io.read(this.id);
    } catch {
      result.warning = 'Черновик доступен только в этой вкладке. Не закрывайте её до отправки.';
    }
    if (!this.alive || this.finishIntent) return;
    const d = result.draft || {
      id: this.id,
      position: this.server.position,
      answer: '',
      photo: null,
    };
    if (d.payload && d.sent === undefined) d.sent = true; // drafts from the previous release have an uncertain outcome
    if (d.photo && !d.photoId) d.photoId = this.io.uuid();
    this.emit({
      draft: d,
      warning: result.warning || '',
      phase: d.payload ? 'failed' : 'preparing',
    });
    if (d.payload) {
      this.frozen = d.payload.durationMs;
      this.emit({
        error:
          d.photoExpected && !d.photo
            ? 'Фото не сохранилось. Прикрепите его снова или выберите «Отправить без фото».'
            : 'Ответ ещё не подтверждён. Повторите отправку.',
      });
      return;
    }
    if (d.resume)
      this.startClock(d.resume.elapsedMs + Math.max(0, this.io.wall() - d.resume.wallStartedAt));
    else if (d.activation)
      this.startClock(Math.max(0, this.io.wall() - d.activation.wallStartedAt));
    else if (this.server.taskStartedAt !== null) {
      const ms = Math.max(
        0,
        this.io.wall() + (this.server.clockOffset || 0) - this.server.taskStartedAt,
      );
      d.activation = {
        readyId: this.server.readyId!,
        startedAt: this.server.taskStartedAt,
        wallStartedAt: this.io.wall() - ms,
      };
      d.resume = { elapsedMs: ms, wallStartedAt: this.io.wall() };
      this.startClock(ms);
      this.put({ ...d });
    }
    if (d.photoExpected && !d.photo)
      this.emit({
        error: 'Фото не сохранилось. Прикрепите его снова или выберите «Отправить без фото».',
      });
  }
  async show() {
    const d = this.state.draft;
    if (
      !d ||
      !this.alive ||
      this.finishIntent ||
      d.payload ||
      !['preparing', 'editing'].includes(this.state.phase)
    )
      return;
    if (!d.activation) {
      const wall = this.io.wall();
      this.startClock(0);
      this.put({
        ...d,
        activation: {
          readyId: this.io.uuid(),
          startedAt: Math.round(wall + (this.server.clockOffset || 0)),
          wallStartedAt: wall,
        },
        resume: { elapsedMs: 0, wallStartedAt: wall },
      });
    }
    if (this.state.phase === 'preparing') this.emit({ phase: 'editing' });
    try {
      await this.register();
    } catch (e) {
      this.error(e);
    }
  }
  private async register() {
    if (this.server.timingVersion === 1) return this.server;
    if (this.registering) return this.registering;
    const d = this.state.draft!;
    if (this.server.readyId === d.activation?.readyId) return this.server;
    const request = (async () => {
      const out = await this.io.ready(this.server, d);
      if (!this.alive) return out;
      if (out.position !== d.position || out.finishedAt !== null) {
        await this.accepted(out);
        return out;
      }
      if (this.finishIntent) return out;
      const live = this.state.draft!;
      if (out.readyId !== live.activation!.readyId) {
        const delta = live.activation!.startedAt - out.taskStartedAt!,
          ms = Math.max(0, this.time + delta);
        const next = {
          ...live,
          activation: {
            readyId: out.readyId!,
            startedAt: out.taskStartedAt!,
            wallStartedAt: this.io.wall() - ms,
          },
        };
        if (live.payload) {
          next.payload = { ...live.payload, readyId: out.readyId!, durationMs: ms };
          this.clock = null;
          this.frozen = ms;
        } else {
          next.resume = { elapsedMs: ms, wallStartedAt: this.io.wall() };
          this.startClock(ms);
        }
        this.put(next);
      }
      this.server = { ...out, clockOffset: out.clockOffset ?? this.server.clockOffset };
      this.io.accept(this.server);
      return out;
    })();
    this.registering = request;
    try {
      return await request;
    } finally {
      if (this.registering === request) this.registering = null;
    }
  }
  async submit() {
    let d = this.state.draft;
    if (
      !this.alive ||
      this.finishIntent ||
      !d ||
      this.sending ||
      this.state.photoBusy ||
      this.state.phase === 'recovering' ||
      this.finished ||
      !d.activation ||
      !d.answer.trim()
    )
      return;
    this.sending = true;
    // Freeze synchronously, before persistence, status checks or network I/O.
    if (!d.payload)
      d = {
        ...d,
        payload: {
          requestId: this.io.uuid(),
          position: d.position,
          taskId: this.server.tasks[d.position].id,
          answer: d.answer.trim(),
          durationMs: this.time,
          readyId: d.activation.readyId,
        },
        sent: false,
      };
    this.frozen = d.payload!.durationMs;
    this.clock = null;
    this.emit({ draft: d, phase: 'sending', error: '' });
    void this.persist(true); // Freeze recovery metadata before waiting for readiness or network.
    try {
      if (d.sent) {
        const out = await this.io.check(this.server);
        if (!this.alive) return;
        if (out.position > d.position || out.finishedAt !== null) {
          await this.accepted(out);
          return;
        }
      }
      if (d.photoExpected && !d.photo)
        throw new Error(
          'Фото не сохранилось. Прикрепите его снова или выберите «Отправить без фото».',
        );
      const ready = await this.register();
      if (
        !this.alive ||
        this.finishIntent ||
        ready.position !== d.position ||
        this.state.phase === 'finished'
      )
        return;
      d = { ...this.state.draft!, sent: true };
      this.emit({ draft: d });
      void this.persist(true); // no storage queue can delay a server upload
      const out = await this.io.send(this.server, d);
      if (!this.alive) return;
      await this.accepted(out);
    } catch (e) {
      if (this.alive && !this.finished && !this.finishIntent) {
        this.emit({ phase: 'failed' });
        this.error(e);
      }
    } finally {
      this.sending = false;
      if (this.alive && this.state.phase === 'sending') this.emit({ phase: 'failed' });
    }
  }
  /** Atomically fence the old request before permitting any edited version. */
  async edit(): Promise<boolean> {
    if (!this.alive || this.finishIntent || this.sending || this.finished) return false;
    if (this.recovery) return this.recovery;
    const d = this.state.draft;
    if (!d) return false;
    if (!d.payload) return true;
    const work = (async () => {
      this.emit({ phase: 'recovering', error: '' });
      try {
        if (d.sent) {
          const out = await this.io.cancel(this.server, d);
          if (!this.alive) return false;
          if (!out.cancelled) {
            await this.accepted(out.snapshot);
            return false;
          }
          this.server = {
            ...out.snapshot,
            clockOffset: out.snapshot.clockOffset ?? this.server.clockOffset,
          };
        }
        if (!this.alive || this.finishIntent) return false;
        const ms = d.payload!.durationMs;
        this.startClock(ms);
        this.emit({
          phase: 'editing',
          draft: {
            ...this.state.draft!,
            payload: undefined,
            sent: false,
            resume: { elapsedMs: ms, wallStartedAt: this.io.wall() },
          },
        });
        void this.persist();
        return true;
      } catch (e) {
        if (this.finishIntent) return false;
        this.emit({ phase: 'failed' });
        this.error(e);
        return false;
      }
    })();
    this.recovery = work;
    try {
      return await work;
    } finally {
      this.recovery = null;
    }
  }
  changeAnswer(answer: string) {
    if (this.state.phase !== 'editing' || !this.state.draft) return;
    this.put({ ...this.state.draft, answer });
  }
  async selectPhoto(file: File | null) {
    if (!this.alive || this.finishIntent || this.sending || this.finished) return;
    const epoch = ++this.photoEpoch;
    this.photoController?.abort();
    const controller = new AbortController();
    this.photoController = controller;
    this.emit({ photoBusy: !!file, error: '' });
    try {
      if (!(await this.edit()) || !this.alive || epoch !== this.photoEpoch) return;
      const prepared = file ? await this.io.prepare(file, controller.signal) : null;
      if (!this.alive || epoch !== this.photoEpoch) return;
      this.put({
        ...this.state.draft!,
        photo: prepared,
        photoId: prepared ? this.io.uuid() : undefined,
        photoExpected: !!prepared,
      });
      this.emit({ error: '' });
    } catch (e) {
      if (this.alive && epoch === this.photoEpoch) this.error(e);
    } finally {
      if (this.alive && epoch === this.photoEpoch) this.emit({ photoBusy: false });
    }
  }
  async withoutPhoto() {
    if (await this.edit()) {
      await this.selectPhoto(null);
      if (this.alive && this.state.phase === 'editing') await this.submit();
    }
  }
  async finish(timeout = false) {
    if (!this.alive || this.finished || this.finishing) return;
    if (this.state.phase === 'loading' && !timeout && !this.finishIntent) return;
    if (!this.finishIntent) {
      this.frozen = this.time;
      this.clock = null;
      this.finishIntent = {
        requestId: this.io.uuid(),
        position: this.server.position,
        durationMs: this.frozen,
        ...(timeout ? { timeout: true } : {}),
      };
      saveFinish(this.server.attemptId, this.finishIntent);
    }
    this.photoEpoch++;
    this.photoController?.abort();
    this.finishing = true;
    this.emit({ phase: 'finishing', photoBusy: false, error: '' });
    try {
      const out = this.finishIntent.timeout
        ? await this.io.check(this.server)
        : await this.io.finish(this.server, this.finishIntent);
      if (out.finishedAt === null && this.finishIntent.timeout) {
        // The browser clock may run ahead. An authoritative active response
        // restores the solver and lets the hook arm one corrected deadline.
        this.finishIntent = null;
        saveFinish(this.server.attemptId, null);
        this.server = out;
        const d = this.state.draft;
        if (d) {
          if (!d.payload) {
            this.startClock(this.frozen);
            this.put({ ...d, resume: { elapsedMs: this.frozen, wallStartedAt: this.io.wall() } });
          }
          this.emit({ phase: d.payload ? 'failed' : 'preparing', error: '' });
        } else await this.init();
        this.io.accept(out);
        return;
      }
      if (out.finishedAt === null)
        throw new Error('Не удалось подтвердить завершение. Повторите проверку.');
      await this.accepted(out);
    } catch (e) {
      if (this.alive && !this.finished) {
        this.emit({ phase: 'finish-failed' });
        this.error(e);
      }
    } finally {
      this.finishing = false;
    }
  }
}
