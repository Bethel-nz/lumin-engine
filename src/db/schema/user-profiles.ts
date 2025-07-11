import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id').primaryKey(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  lastActiveAt: text('last_active_at').default(sql`CURRENT_TIMESTAMP`),
  demographics: text('demographics', { mode: 'json' }).$type<
    Record<string, unknown>
  >(),
});

export const insertUserProfilesSchema = z.object({
  userId: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastActiveAt: z.string().optional(),
  demographics: z.record(z.unknown()).optional(),
});

export const selectUserProfilesSchema = z.object({
  userId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActiveAt: z.string(),
  demographics: z.record(z.unknown()).nullable(),
});
