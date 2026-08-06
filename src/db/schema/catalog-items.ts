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
