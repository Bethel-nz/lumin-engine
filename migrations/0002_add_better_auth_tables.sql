-- Better Auth core tables (user, session, account, verification)
CREATE TABLE IF NOT EXISTS `user` (
    `id` text PRIMARY KEY NOT NULL,
    `name` text NOT NULL,
    `email` text NOT NULL,
    `email_verified` integer NOT NULL DEFAULT 0,
    `image` text,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_user_email` ON `user`(`email`);

CREATE TABLE IF NOT EXISTS `session` (
    `id` text PRIMARY KEY NOT NULL,
    `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
    `token` text NOT NULL,
    `expires_at` integer NOT NULL,
    `ip_address` text,
    `user_agent` text,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_session_token` ON `session`(`token`);
CREATE INDEX IF NOT EXISTS `idx_session_user_id` ON `session`(`user_id`);

CREATE TABLE IF NOT EXISTS `account` (
    `id` text PRIMARY KEY NOT NULL,
    `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
    `account_id` text NOT NULL,
    `provider_id` text NOT NULL,
    `access_token` text,
    `refresh_token` text,
    `access_token_expires_at` integer,
    `refresh_token_expires_at` integer,
    `scope` text,
    `id_token` text,
    `password` text,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_account_user_id` ON `account`(`user_id`);

CREATE TABLE IF NOT EXISTS `verification` (
    `id` text PRIMARY KEY NOT NULL,
    `identifier` text NOT NULL,
    `value` text NOT NULL,
    `expires_at` integer NOT NULL,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

-- API Key plugin table
CREATE TABLE IF NOT EXISTS `apikey` (
    `id` text PRIMARY KEY NOT NULL,
    `name` text,
    `start` text,
    `prefix` text,
    `key` text NOT NULL,
    `reference_id` text NOT NULL,
    `config_id` text NOT NULL DEFAULT 'default',
    `refill_interval` integer,
    `refill_amount` integer,
    `last_refill_at` integer,
    `enabled` integer NOT NULL DEFAULT 1,
    `rate_limit_enabled` integer NOT NULL DEFAULT 0,
    `rate_limit_time_window` integer,
    `rate_limit_max` integer,
    `request_count` integer NOT NULL DEFAULT 0,
    `remaining` integer,
    `last_request` integer,
    `expires_at` integer,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL,
    `permissions` text,
    `metadata` text
);

CREATE INDEX IF NOT EXISTS `idx_apikey_reference_id` ON `apikey`(`reference_id`);
CREATE INDEX IF NOT EXISTS `idx_apikey_config_id` ON `apikey`(`config_id`);
CREATE INDEX IF NOT EXISTS `idx_apikey_key` ON `apikey`(`key`);
