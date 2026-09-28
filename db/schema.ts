import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull().unique(),
    title: text('title').notNull(),
    teacherHash: text('teacher_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    count: integer('count').notNull(),
    amcYear: integer('amc_year'),
  },
  (t) => [index('rooms_expiry').on(t.expiresAt)],
);
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    fileKey: text('file_key').notNull(),
    mime: text('mime').notNull(),
    answer: text('answer').notNull(),
    topic: text('topic'),
  },
  (t) => [uniqueIndex('tasks_room_ordinal').on(t.roomId, t.ordinal)],
);
export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    secretHash: text('secret_hash').notNull(),
    orderJson: text('order_json').notNull(),
    position: integer('position').notNull().default(0),
    startedAt: integer('started_at').notNull(),
    taskStartedAt: integer('task_started_at').notNull(),
    finishedAt: integer('finished_at'),
    timingVersion: integer('timing_version').notNull().default(1),
    readyId: text('ready_id'),
    resultExpiresAt: integer('result_expires_at'),
    deadlineAt: integer('deadline_at'),
    finishReason: text('finish_reason'),
    finishRequestId: text('finish_request_id'),
    unfinishedMs: integer('unfinished_ms').notNull().default(0),
    timingIncomplete: integer('timing_incomplete').notNull().default(0),
    stateVersion: integer('state_version').notNull().default(0),
    selectedTaskId: text('selected_task_id'),
  },
  (t) => [
    index('attempts_room_start').on(t.roomId, t.startedAt),
    index('attempts_result_expiry').on(t.resultExpiresAt),
    index('attempts_active_deadline').on(t.finishedAt, t.deadlineAt),
  ],
);
export const answers = sqliteTable(
  'answers',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    answer: text('answer').notNull(),
    correct: integer('correct').notNull(),
    startedAt: integer('started_at').notNull(),
    answeredAt: integer('answered_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    readyId: text('ready_id'),
    receivedAt: integer('received_at'),
    solutionKey: text('solution_key'),
    solutionMime: text('solution_mime'),
    solutionDigest: text('solution_digest'),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    uniqueIndex('answers_attempt_position').on(t.attemptId, t.position),
    uniqueIndex('answers_attempt_request').on(t.attemptId, t.requestId),
    uniqueIndex('answers_attempt_task').on(t.attemptId, t.taskId),
  ],
);
export const intervals = sqliteTable(
  'attempt_intervals',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    startedAt: integer('started_at'),
    durationMs: integer('duration_ms').notNull().default(0),
    closedAt: integer('closed_at'),
  },
  (t) => [index('intervals_attempt_task').on(t.attemptId, t.taskId)],
);
export const operations = sqliteTable(
  'attempt_operations',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    token: text('token').notNull(),
  },
  (t) => [uniqueIndex('operations_attempt_request').on(t.attemptId, t.requestId)],
);
export const exports = sqliteTable(
  'sheet_exports',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    documentId: text('document_id').notNull(),
    sheetId: integer('sheet_id').notNull(),
    marker: text('marker').notNull(),
    payload: text('payload').notNull(),
    completed: integer('completed').notNull().default(0),
  },
  (t) => [uniqueIndex('exports_attempt_format').on(t.attemptId, t.format)],
);
export const blobs = sqliteTable(
  'blobs',
  {
    key: text('key').primaryKey(),
    expiresAt: integer('expires_at').notNull(),
    state: text('state').notNull().default('live'),
  },
  (t) => [index('blobs_expiry').on(t.expiresAt)],
);
export const expiredAttempts = sqliteTable('expired_attempts', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  teacherHash: text('teacher_hash').notNull(),
  reason: text('reason').notNull(),
});
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    hits: integer('hits').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('limits_expiry').on(t.expiresAt)],
);

export const cancelledAnswers = sqliteTable(
  'cancelled_answers',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
  },
  (t) => [uniqueIndex('cancelled_answer_request').on(t.attemptId, t.requestId)],
);
