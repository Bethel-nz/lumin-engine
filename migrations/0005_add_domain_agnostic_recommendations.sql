CREATE TABLE `catalog_items` (
  `tenant_id` text NOT NULL,
  `catalog_id` text NOT NULL,
  `item_id` text NOT NULL,
  `title` text NOT NULL,
  `description` text,
  `tags` text NOT NULL DEFAULT '[]',
  `category` text,
  `image_url` text,
  `price` real,
  `attributes` text NOT NULL DEFAULT '{}',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`tenant_id`, `catalog_id`, `item_id`),
  FOREIGN KEY (`catalog_id`) REFERENCES `catalogs`(`id`) ON DELETE CASCADE
);

CREATE INDEX `catalog_items_lookup_idx`
  ON `catalog_items` (`tenant_id`, `catalog_id`, `updated_at`);

CREATE INDEX `catalog_items_category_idx`
  ON `catalog_items` (`tenant_id`, `catalog_id`, `category`);

CREATE TABLE `catalog_interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `catalog_id` text NOT NULL,
  `user_id` text NOT NULL,
  `item_id` text NOT NULL,
  `action` text NOT NULL,
  `weight` real NOT NULL,
  `timestamp` integer NOT NULL,
  `session_id` text NOT NULL,
  `source` text NOT NULL,
  `metadata` text,
  FOREIGN KEY (`catalog_id`) REFERENCES `catalogs`(`id`) ON DELETE CASCADE
);

CREATE INDEX `catalog_interactions_user_idx`
  ON `catalog_interactions`
  (`tenant_id`, `catalog_id`, `user_id`, `timestamp`);

CREATE INDEX `catalog_interactions_item_idx`
  ON `catalog_interactions`
  (`tenant_id`, `catalog_id`, `item_id`, `timestamp`);
