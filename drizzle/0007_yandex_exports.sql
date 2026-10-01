-- Separate immutable export receipts from attempts: result cleanup must not
-- forget a completed worksheet or an upload whose acknowledgement was lost.
CREATE TABLE `yandex_export_books` (
  `path` text PRIMARY KEY NOT NULL,
  `book_id` text NOT NULL UNIQUE,
  `last_hash` text,
  `active_job` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yandex_export_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL,
  `format` text NOT NULL CHECK (`format` IN ('amc8','free')),
  `book_path` text NOT NULL,
  `book_id` text NOT NULL,
  `marker` text NOT NULL UNIQUE,
  `payload` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('queued','preparing','uploading','ambiguous','retryable','conflict','complete')),
  `baseline_hash` text,
  `payload_hash` text,
  `payload_bytes` blob,
  `worksheet_name` text,
  `lease_token` text,
  `lease_until` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `yandex_export_attempt_format` ON `yandex_export_jobs` (`attempt_id`,`format`);
--> statement-breakpoint
CREATE INDEX `yandex_export_queue` ON `yandex_export_jobs` (`book_path`,`status`,`created_at`);
