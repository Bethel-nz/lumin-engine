ALTER TABLE `compensation_queue` ADD COLUMN `claimed_at` integer;

CREATE INDEX IF NOT EXISTS `idx_compensation_queue_claim`
ON `compensation_queue`(`status`, `claimed_at`, `timestamp`);
