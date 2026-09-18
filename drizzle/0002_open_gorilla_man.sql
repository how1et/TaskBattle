CREATE TABLE `cancelled_answers` (
	`attempt_id` text NOT NULL,
	`request_id` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cancelled_answer_request` ON `cancelled_answers` (`attempt_id`,`request_id`);