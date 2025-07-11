import { relations, sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  metadata: text('metadata', { mode: 'json' }),
});

export const eventTags = sqliteTable(
  'event_tags',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.eventId, table.tag] }),
  })
);

export const insertEventsSchema = z.object({
  id: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  metadata: z.any().optional(),
});
export const selectEventsSchema = z.object({
  id: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  metadata: z.any().nullable(),
});

export const eventsRelations = relations(events, ({ many }) => ({
  tags: many(eventTags),
}));

export const eventTagsRelations = relations(eventTags, ({ one }) => ({
  event: one(events, {
    fields: [eventTags.eventId],
    references: [events.id],
  }),
}));
