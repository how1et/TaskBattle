import { summarize } from '../normalization';
import type { JourneyState } from '../journey-types';
import { roomTasks, sql, type Attempt, type Room } from './context';
type Interval = {
  id: string;
  task_id: string;
  owner: string;
  started_at: number | null;
  duration_ms: number;
  closed_at: number | null;
};
type Answer = {
  task_id: string;
  answer: string;
  revision: number;
  correct: number;
  solution_key: string | null;
  solution_mime: string | null;
  solution_digest: string | null;
  started_at: number;
  answered_at: number;
};
const fresh = async (id: string) =>
  (await sql('SELECT * FROM attempts WHERE id=?', id).first<Attempt>())!;

export async function journeySnapshot(a: Attempt, r: Room) {
  // The deadline job may finish a sleeping browser. Close its last running visit once.
  if (a.finished_at !== null)
    await sql(
      `UPDATE attempt_intervals SET closed_at=? WHERE attempt_id=? AND closed_at IS NULL`,
      a.finished_at,
      a.id,
    ).run();
  const ts = await roomTasks(r.id);
  const visits = (
    await sql('SELECT * FROM attempt_intervals WHERE attempt_id=?', a.id).all<Interval>()
  ).results;
  const answers = (await sql('SELECT * FROM answers WHERE attempt_id=?', a.id).all<Answer>())
    .results;
  const current = await fresh(a.id);
  if (current.state_version !== a.state_version || current.finished_at !== a.finished_at)
    return journeySnapshot(current, r);
  const times: Record<string, number> = {};
  for (const t of ts)
    times[t.id] = visits
      .filter((v) => v.task_id === t.id && v.closed_at !== null)
      .reduce((s, v) => s + v.duration_ms, 0);
  const active = visits.find((v) => v.id === a.ready_id && v.closed_at === null);
  const journey: JourneyState = {
    version: a.state_version,
    selected: a.selected_task_id || ts[0].id,
    times,
    visit: active
      ? { id: active.id, taskId: active.task_id, owner: active.owner, startedAt: active.started_at }
      : null,
    accepted: {},
    legacySlots: Object.fromEntries(
      (JSON.parse(a.order_json) as string[]).map((id, index) => [id, index]),
    ),
  };
  for (const answer of answers)
    journey.accepted[answer.task_id] = {
      answer: answer.answer,
      revision: answer.revision,
      solutionPhoto: answer.solution_key
        ? `/api/attempts/${a.id}/solutions/${answer.task_id}?revision=${answer.revision}`
        : null,
    };
  const tasks = ts.map((t) => ({
    id: t.id,
    ordinal: t.ordinal,
    topic: t.topic,
    photo: `/api/attempts/${a.id}/photos/${t.id}`,
  }));
  const completedMs = Object.values(times).reduce((s, v) => s + v, 0);
  const expiresAt = a.finished_at !== null ? a.result_expires_at! : a.deadline_at;
  const base = {
    attemptId: a.id,
    roomId: r.id,
    title: r.title,
    amcYear: r.amc_year,
    roomExpiresAt: r.expires_at,
    expiresAt,
    deadlineAt: a.deadline_at,
    finishReason: a.finish_reason,
    timingIncomplete: !!a.timing_incomplete,
    unfinishedMs: 0,
    resultExpiresAt: a.result_expires_at,
    count: r.count,
    position: answers.length,
    startedAt: a.started_at,
    taskStartedAt: active?.started_at || null,
    readyId: a.ready_id,
    timingVersion: 3,
    completedMs,
    finishedAt: a.finished_at,
    serverNow: Date.now(),
    tasks,
    journey,
  };
  if (a.finished_at === null) return base;
  const report = tasks.map((t) => {
    const answer = answers.find((v) => v.task_id === t.id);
    return {
      ...t,
      answer: answer?.answer ?? null,
      submitted: !!answer,
      correctAnswer: ts.find((v) => v.id === t.id)!.answer,
      correct: answer ? !!answer.correct : null,
      durationMs: times[t.id],
      solutionPhoto: journey.accepted[t.id]?.solutionPhoto || null,
    };
  });
  const unsubmitted = report.filter((t) => !t.submitted).reduce((s, t) => s + t.durationMs, 0);
  return {
    ...base,
    unfinishedMs: unsubmitted,
    report,
    summary: summarize(report, undefined, unsubmitted),
  };
}
