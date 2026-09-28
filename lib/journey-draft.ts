import type { AnswerDraft } from './answer-draft';
import type { JourneyAnswer } from './journey-types';
export type JourneyDraft = AnswerDraft & {
  revision?: number;
  photoAction?: 'keep' | 'replace' | 'remove';
  dirty?: boolean;
  operation?: JourneyAnswer;
};
export type VisitClock = { id: string; taskId: string; start: number | null; elapsed: number };
export function visitTime(clock: VisitClock | null, now = Date.now()) {
  return clock
    ? Math.round(clock.elapsed + (clock.start === null ? 0 : Math.max(0, now - clock.start)))
    : 0;
}
export function freezeVisit(clock: VisitClock | null, now = Date.now()): VisitClock | null {
  return clock ? { ...clock, elapsed: visitTime(clock, now), start: null } : null;
}
