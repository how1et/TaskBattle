ALTER TABLE `attempts` ADD `deadline_at` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `finish_reason` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `finish_request_id` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `unfinished_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `timing_incomplete` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `attempts_active_deadline` ON `attempts` (`finished_at`,`deadline_at`);