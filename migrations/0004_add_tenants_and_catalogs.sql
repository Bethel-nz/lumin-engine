CREATE TABLE IF NOT EXISTS `tenants` (
    `id` text PRIMARY KEY NOT NULL,
    `name` text NOT NULL,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE TABLE IF NOT EXISTS `catalogs` (
    `id` text PRIMARY KEY NOT NULL,
    `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
    `name` text NOT NULL,
    `fields` text NOT NULL,
    `embed_config` text NOT NULL,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_catalogs_tenant_id` ON `catalogs`(`tenant_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_catalogs_tenant_name` ON `catalogs`(`tenant_id`, `name`);
