CREATE TABLE `retention_policy` (
	`key` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `attempts` ADD `result_ttl_ms` integer;--> statement-breakpoint
CREATE INDEX `attempts_retention_migration` ON `attempts` (`result_ttl_ms`,`id`);