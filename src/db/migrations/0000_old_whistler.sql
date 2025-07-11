CREATE TABLE `user_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	`last_active_at` text DEFAULT CURRENT_TIMESTAMP,
	`demographics` text
);
--> statement-breakpoint
CREATE TABLE `event_tags` (
	`event_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`event_id`, `tag`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`action` text NOT NULL,
	`timestamp` text DEFAULT 'CURRENT_TIMESTAMP',
	`metadata` text
);
