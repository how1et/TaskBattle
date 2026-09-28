export type Visit = { id: string; taskId: string; owner: string; startedAt: number | null };
export type AcceptedAnswer = { answer: string; revision: number; solutionPhoto: string | null };
export type JourneyState = {
  version: number;
  selected: string;
  visit: Visit | null;
  times: Record<string, number>;
  accepted: Record<string, AcceptedAnswer>;
  legacySlots: Record<string, number>;
};
export type JourneyAnswer = {
  requestId: string;
  taskId: string;
  version: number;
  revision: number;
  answer: string;
  photoAction: 'keep' | 'replace' | 'remove';
};
