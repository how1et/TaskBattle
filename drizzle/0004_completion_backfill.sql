-- Custom SQL migration file, put your code below! --
-- Separate data backfill after the additive schema migration. No deletes or file changes.
UPDATE attempts SET deadline_at=started_at+86400000 WHERE deadline_at IS NULL;
--> statement-breakpoint
UPDATE attempts SET finish_reason='completed' WHERE finished_at IS NOT NULL AND finish_reason IS NULL;
--> statement-breakpoint
-- Only rooms still live at deployment qualify; expired rooms are never reopened.
UPDATE rooms SET expires_at=created_at+1209600000 WHERE expires_at>(julianday('now')-2440587.5)*86400000;
--> statement-breakpoint
UPDATE blobs SET expires_at=MAX(expires_at,COALESCE((SELECT MAX(r.expires_at) FROM tasks t JOIN rooms r ON r.id=t.room_id WHERE t.file_key=blobs.key),expires_at)) WHERE state='live';
