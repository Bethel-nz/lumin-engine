-- Add user_similarities table for pre-computed user similarities
CREATE TABLE IF NOT EXISTS `user_similarities` (
    `id` text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    `user_id` text NOT NULL,
    `similar_user_id` text NOT NULL,
    `similarity_score` real NOT NULL,
    `common_interactions` integer NOT NULL,
    `last_updated` integer NOT NULL,
    UNIQUE(`user_id`, `similar_user_id`),
    FOREIGN KEY (`user_id`) REFERENCES `user_profiles`(`user_id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`similar_user_id`) REFERENCES `user_profiles`(`user_id`) ON UPDATE no action ON DELETE cascade
);

-- Add similarity_batch_jobs table for tracking batch computation jobs
CREATE TABLE IF NOT EXISTS `similarity_batch_jobs` (
    `id` text PRIMARY KEY NOT NULL,
    `status` text NOT NULL CHECK (`status` IN ('pending', 'running', 'completed', 'failed')),
    `user_batch_start` text NOT NULL,
    `user_batch_end` text NOT NULL,
    `created_at` integer NOT NULL,
    `started_at` integer,
    `completed_at` integer,
    `processed_users` integer NOT NULL DEFAULT 0,
    `total_similarities` integer NOT NULL DEFAULT 0,
    `error` text
);

-- Add compensation_queue table for handling partial failures
CREATE TABLE IF NOT EXISTS `compensation_queue` (
    `id` text PRIMARY KEY NOT NULL,
    `type` text NOT NULL CHECK (`type` IN ('rollback', 'retry', 'manual_intervention')),
    `description` text NOT NULL,
    `payload` json NOT NULL,
    `timestamp` integer NOT NULL,
    `status` text NOT NULL CHECK (`status` IN ('pending', 'completed', 'failed')),
    `retry_count` integer NOT NULL DEFAULT 0,
    `max_retries` integer DEFAULT 3,
    `error` text
);

-- Add weight column to interactions table if not exists
ALTER TABLE `interactions` ADD COLUMN `weight` real DEFAULT 1.0;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS `idx_user_similarities_user_id` ON `user_similarities`(`user_id`);
CREATE INDEX IF NOT EXISTS `idx_user_similarities_similarity_score` ON `user_similarities`(`similarity_score` DESC);
CREATE INDEX IF NOT EXISTS `idx_user_similarities_last_updated` ON `user_similarities`(`last_updated`);

CREATE INDEX IF NOT EXISTS `idx_similarity_batch_jobs_status` ON `similarity_batch_jobs`(`status`);
CREATE INDEX IF NOT EXISTS `idx_similarity_batch_jobs_created_at` ON `similarity_batch_jobs`(`created_at`);

CREATE INDEX IF NOT EXISTS `idx_compensation_queue_status` ON `compensation_queue`(`status`);
CREATE INDEX IF NOT EXISTS `idx_compensation_queue_timestamp` ON `compensation_queue`(`timestamp`);

-- Optimize existing interactions table with better indexes
CREATE INDEX IF NOT EXISTS `idx_interactions_user_id_action` ON `interactions`(`user_id`, `action`);
CREATE INDEX IF NOT EXISTS `idx_interactions_event_id_action` ON `interactions`(`event_id`, `action`);
CREATE INDEX IF NOT EXISTS `idx_interactions_timestamp` ON `interactions`(`timestamp`);
CREATE INDEX IF NOT EXISTS `idx_interactions_user_event_action` ON `interactions`(`user_id`, `event_id`, `action`);

-- Add country and interests columns to user_profiles if they don't exist
ALTER TABLE `user_profiles` ADD COLUMN `country` text;
ALTER TABLE `user_profiles` ADD COLUMN `interests` json;