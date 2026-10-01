CREATE TABLE `migration_gate` (
  `singleton` integer PRIMARY KEY CHECK (`singleton` = 1),
  `frozen` integer NOT NULL DEFAULT 0 CHECK (`frozen` IN (0, 1)),
  `frozen_at` integer,
  `updated_at` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `migration_gate` (`singleton`, `frozen`, `frozen_at`, `updated_at`) VALUES (1, 0, NULL, 0);
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_rooms_insert`
BEFORE INSERT ON `rooms`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_rooms_update`
BEFORE UPDATE ON `rooms`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_rooms_delete`
BEFORE DELETE ON `rooms`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_tasks_insert`
BEFORE INSERT ON `tasks`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_tasks_update`
BEFORE UPDATE ON `tasks`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_tasks_delete`
BEFORE DELETE ON `tasks`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempts_insert`
BEFORE INSERT ON `attempts`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempts_update`
BEFORE UPDATE ON `attempts`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempts_delete`
BEFORE DELETE ON `attempts`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_answers_insert`
BEFORE INSERT ON `answers`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_answers_update`
BEFORE UPDATE ON `answers`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_answers_delete`
BEFORE DELETE ON `answers`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempt_intervals_insert`
BEFORE INSERT ON `attempt_intervals`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempt_intervals_update`
BEFORE UPDATE ON `attempt_intervals`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempt_intervals_delete`
BEFORE DELETE ON `attempt_intervals`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempt_operations_insert`
BEFORE INSERT ON `attempt_operations`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempt_operations_update`
BEFORE UPDATE ON `attempt_operations`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_attempt_operations_delete`
BEFORE DELETE ON `attempt_operations`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_sheet_exports_insert`
BEFORE INSERT ON `sheet_exports`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_sheet_exports_update`
BEFORE UPDATE ON `sheet_exports`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_sheet_exports_delete`
BEFORE DELETE ON `sheet_exports`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_blobs_insert`
BEFORE INSERT ON `blobs`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_blobs_update`
BEFORE UPDATE ON `blobs`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_blobs_delete`
BEFORE DELETE ON `blobs`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_expired_attempts_insert`
BEFORE INSERT ON `expired_attempts`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_expired_attempts_update`
BEFORE UPDATE ON `expired_attempts`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_expired_attempts_delete`
BEFORE DELETE ON `expired_attempts`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_rate_limits_insert`
BEFORE INSERT ON `rate_limits`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_rate_limits_update`
BEFORE UPDATE ON `rate_limits`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_rate_limits_delete`
BEFORE DELETE ON `rate_limits`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_cancelled_answers_insert`
BEFORE INSERT ON `cancelled_answers`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_cancelled_answers_update`
BEFORE UPDATE ON `cancelled_answers`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
--> statement-breakpoint
CREATE TRIGGER `migration_freeze_cancelled_answers_delete`
BEFORE DELETE ON `cancelled_answers`
WHEN (SELECT frozen FROM migration_gate WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'TASKBATTLE_MAINTENANCE');
END;
