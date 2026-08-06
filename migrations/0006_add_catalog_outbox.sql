-- D1 is the source of truth. Every catalog write records its required derived
-- work in this same transaction, so a Vector or Tinybird outage cannot turn a
-- successful API request into permanently incomplete recommendation state.
CREATE TABLE `catalog_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `tenant_id` text NOT NULL,
  `catalog_id` text NOT NULL,
  `payload` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `attempts` integer NOT NULL DEFAULT 0,
  `available_at` integer NOT NULL,
  `claimed_at` integer,
  `last_error` text,
  `created_at` integer NOT NULL,
  `completed_at` integer
);

CREATE INDEX `catalog_outbox_ready_idx`
  ON `catalog_outbox` (`status`, `available_at`, `created_at`);
