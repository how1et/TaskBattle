CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`position` integer NOT NULL,
	`task_id` text NOT NULL,
	`request_id` text NOT NULL,
	`answer` text NOT NULL,
	`correct` integer NOT NULL,
	`started_at` integer NOT NULL,
	`answered_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answers_attempt_position` ON `answers` (`attempt_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `answers_attempt_request` ON `answers` (`attempt_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`order_json` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`task_started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attempts_room_start` ON `attempts` (`room_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`key` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blobs_expiry` ON `blobs` (`expires_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `limits_expiry` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`title` text NOT NULL,
	`teacher_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_request_id_unique` ON `rooms` (`request_id`);--> statement-breakpoint
CREATE INDEX `rooms_expiry` ON `rooms` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`file_key` text NOT NULL,
	`mime` text NOT NULL,
	`answer` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_room_ordinal` ON `tasks` (`room_id`,`ordinal`);