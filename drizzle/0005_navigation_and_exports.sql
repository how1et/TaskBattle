CREATE TABLE `sheet_exports` (
	`attempt_id` text NOT NULL,
	`format` text NOT NULL,
	`document_id` text NOT NULL,
	`sheet_id` integer NOT NULL,
	`marker` text NOT NULL,
	`payload` text NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exports_attempt_format` ON `sheet_exports` (`attempt_id`,`format`);--> statement-breakpoint
CREATE TABLE `attempt_intervals` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`task_id` text NOT NULL,
	`owner` text NOT NULL,
	`started_at` integer,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intervals_attempt_task` ON `attempt_intervals` (`attempt_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `attempt_operations` (
	`attempt_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`token` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_attempt_request` ON `attempt_operations` (`attempt_id`,`request_id`);--> statement-breakpoint
ALTER TABLE `answers` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `answers_attempt_task` ON `answers` (`attempt_id`,`task_id`);--> statement-breakpoint
ALTER TABLE `attempts` ADD `state_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `selected_task_id` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `amc_year` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `topic` text;