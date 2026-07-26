import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { catalogs } from './catalogs';

export const catalogItems = sqliteTable(
  'catalog_items',
  {
    tenantId: text('tenant_id').notNull(),
    catalogId: text('catalog_id')
      .notNull()
      .references(() => catalogs.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    tags: text('tags').notNull().default('[]'),
    category: text('category'),
    imageUrl: text('image_url'),
    price: real('price'),
    attributes: text('attributes').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.catalogId, table.itemId],
    }),
  ]
);

export const catalogInteractions = sqliteTable('catalog_interactions', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  catalogId: text('catalog_id')
    .notNull()
    .references(() => catalogs.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  itemId: text('item_id').notNull(),
  action: text('action').notNull(),
  weight: real('weight').notNull(),
  timestamp: integer('timestamp').notNull(),
  sessionId: text('session_id').notNull(),
  source: text('source').notNull(),
  metadata: text('metadata'),
});
