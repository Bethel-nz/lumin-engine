import { z } from 'zod';
import {
  defineSchema,
  defineDataSource,
  string,
  int64,
  array,
  nullable,
} from '@vyr-e/tinykit';

export const eventsSchema = defineSchema({
  id: string('id'),
  title: string('title'),
  description: nullable('description', z.string(), { innerType: 'String' }),
  tags: array('tags', z.string(), { innerType: 'String' }),
  host: nullable('host', z.string(), { innerType: 'String' }),
  category: nullable('category', z.string(), { innerType: 'String' }),
  image_url: nullable('image_url', z.string(), { innerType: 'String' }),
  event_date: nullable('event_date', z.number(), { innerType: 'Int64' }),
  location: nullable('location', z.string(), { innerType: 'String' }),
  capacity: nullable('capacity', z.number().int(), { innerType: 'Int64' }),
  price: nullable('price', z.number(), { innerType: 'Float64' }),
  created_at: int64('created_at'),
  updated_at: int64('updated_at'),
  // For metadata, we store it as a stringified JSON.
  // The API layer will handle the stringification.
  metadata: nullable('metadata', z.string(), { innerType: 'String' }),
});

export const eventsDataSource = defineDataSource({
  name: 'events__v1',
  schema: eventsSchema,
  engine: 'MergeTree',
  sortingKey: ['created_at', 'id'],
});

export const interactionsSchema = defineSchema({
  id: string('id'),
  user_id: string('user_id'),
  event_id: string('event_id'),
  action: string('action'),
  session_id: string('session_id'),
  source: string('source'),
  duration_ms: nullable('duration_ms', z.number().int(), {
    innerType: 'Int64',
  }),
  tags: nullable('tags', z.array(z.string()), { innerType: 'Array(String)' }),
  timestamp: int64('timestamp'),
  metadata: nullable('metadata', z.string(), { innerType: 'String' }),
});

export const interactionsDataSource = defineDataSource({
  name: 'interactions__v1',
  schema: interactionsSchema,
  engine: 'MergeTree',
  sortingKey: ['timestamp', 'user_id', 'event_id'],
});

// ---- INGESTION SCHEMAS ----
export const ingestEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  host: z.string().optional(),
  category: z.string().optional(),
  image_url: z.string().url().optional(),
  event_date: z.number().int().optional(),
  location: z.string().optional(),
  capacity: z.number().int().optional(),
  price: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});

export const logInteractionSchema = z
  .object({
    id: z.string().min(1),
    user_id: z.string().min(1),
    event_id: z.string().min(1),
    action: z.enum([
      'view',
      'click',
      'like',
      'dislike',
      'signup',
      'select_tags',
    ]),
    session_id: z.string(),
    source: z.string().default('web'),
    duration_ms: z.number().int().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
  })
  .refine(
    (data) =>
      !(
        data.action === 'select_tags' &&
        (!data.tags || data.tags.length === 0)
      ),
    {
      message: "Tags array must be provided for 'select_tags' action",
      path: ['tags'],
    }
  );

export const trendingEventsQuerySchema = z.object({
  limit: z.number().int().default(10),
  hours: z.number().int().positive().default(24),
  category: z.string().optional(),
});

export const realtimeTrendingQuerySchema = z.object({
  limit: z.number().int().default(10),
  minutes: z.number().int().positive().default(60),
});

export const userBehaviorQuerySchema = z.object({
  user_id: z.string().min(1),
  days: z.number().int().positive().default(30),
});

export const locationTrendsQuerySchema = z.object({
  location: z.string().min(1),
  limit: z.number().int().default(10),
  days: z.number().int().positive().default(7),
});

export const eventSimilarityQuerySchema = z.object({
  event_id: z.string(),
  limit: z.number().int().default(20),
});

export const trendingEventResponseSchema = z.object({
  event_id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  interaction_count: z.number(),
  engagement_rate: z.number(),
});

export const realtimeTrendingResponseSchema = z.object({
  event_id: z.string(),
  interaction_velocity: z.number(),
  engagement_score: z.number(),
});

export const userBehaviorResponseSchema = z.object({
  preferred_categories: z.array(z.string()),
});

export const locationTrendResponseSchema = z.object({
  event_id: z.string(),
  interaction_count: z.number(),
  engagement_rate: z.number(),
});

export const eventSimilarityResponseSchema = z.object({
  event_id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  similarity_score: z.number(),
});

export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type LogInteraction = z.infer<typeof logInteractionSchema>;
