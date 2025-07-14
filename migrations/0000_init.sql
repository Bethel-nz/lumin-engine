CREATE TABLE IF NOT EXISTS `user_profiles` (
    `user_id` text PRIMARY KEY NOT NULL,
    `created_at` text DEFAULT (CURRENT_TIMESTAMP),
    `updated_at` text DEFAULT (CURRENT_TIMESTAMP),
    `last_active_at` text DEFAULT (CURRENT_TIMESTAMP),
    `demographics` json
);CREATE TABLE IF NOT EXISTS `events` (
    `id` text PRIMARY KEY NOT NULL,
    `created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    `updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    `metadata` json
);
CREATE TABLE IF NOT EXISTS `event_tags` (
    `event_id` text NOT NULL,
    `tag` text NOT NULL,
    PRIMARY KEY (`event_id`, `tag`),
    FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS `interactions` (
    `id` text PRIMARY KEY NOT NULL,
    `user_id` text NOT NULL,
    `event_id` text NOT NULL,
    `action` text NOT NULL,
    `timestamp` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
    `metadata` json,
    FOREIGN KEY (`user_id`) REFERENCES `user_profiles`(`user_id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
); 