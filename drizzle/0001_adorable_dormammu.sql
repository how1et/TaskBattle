CREATE TABLE `expired_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`teacher_hash` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `answers` ADD `ready_id` text;--> statement-breakpoint
ALTER TABLE `answers` ADD `received_at` integer;--> statement-breakpoint
ALTER TABLE `answers` ADD `solution_key` text;--> statement-breakpoint
ALTER TABLE `answers` ADD `solution_mime` text;--> statement-breakpoint
ALTER TABLE `answers` ADD `solution_digest` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `timing_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `ready_id` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `result_expires_at` integer;--> statement-breakpoint
CREATE INDEX `attempts_result_expiry` ON `attempts` (`result_expires_at`);--> statement-breakpoint
ALTER TABLE `blobs` ADD `state` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
UPDATE attempts SET result_expires_at = finished_at + 259200000 WHERE finished_at IS NOT NULL;
--> statement-breakpoint
UPDATE blobs SET expires_at = MAX(expires_at, COALESCE((SELECT MAX(a.result_expires_at) FROM tasks t JOIN attempts a ON a.room_id=t.room_id WHERE t.file_key=blobs.key), expires_at));
