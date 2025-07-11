import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { nanoid } from 'nanoid';

export const interactions = sqliteTable('interactions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  userId: text('user_id').notNull(),
  eventId: text('event_id').notNull(),
  action: text('action').notNull(),
  timestamp: text('timestamp').default('CURRENT_TIMESTAMP'),
  metadata: text('metadata', { mode: 'json' }),
});

export const insertInteractionsSchema = createInsertSchema(interactions);
export const selectInteractionsSchema = createSelectSchema(interactions);
