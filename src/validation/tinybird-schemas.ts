import { z } from 'zod';
import { nanoid } from 'nanoid';

// Enhanced event schema for TinyBird
export const tinybirdEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).min(1),
  host: z.string().optional(),
  category: z.string().optional(),
  event_date: z.number().int().optional(), // Unix timestamp when event happens
  location: z.string().optional(),
  capacity: z.number().int().optional(),
  price: z.number().optional(),
  created_at: z.number().int().default(() => Date.now()),
  updated_at: z.number().int().default(() => Date.now()),
  metadata: z.record(z.any()).optional()
});

// Enhanced interaction schema for TinyBird
export const tinybirdInteractionSchema = z.object({
  id: z.string().default(() => nanoid()),
  user_id: z.string().min(1),
  event_id: z.string().min(1),
  action: z.enum(['view', 'click', 'like', 'dislike', 'signup', 'select_tags']),
  session_id: z.string(),
  source: z.string().default('web'),
  duration_ms: z.number().int().optional(),
  page_depth: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  timestamp: z.number().int().default(() => Date.now()),
  metadata: z.record(z.any()).optional()
});

// Enhanced ingestion schema (backward compatible)
export const ingestEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).min(1),
  host: z.string().optional(),
  category: z.string().optional(),
  event_date: z.string().datetime().optional().transform(date => 
    date ? Math.floor(new Date(date).getTime() / 1000) : undefined
  ),
  location: z.string().optional(),
  capacity: z.number().int().optional(),
  price: z.number().optional(),
  metadata: z.record(z.any()).optional()
});

// Enhanced interaction schema (backward compatible)
export const logInteractionSchema = z.object({
  user_id: z.string().min(1),
  event_id: z.string().min(1),
  action: z.enum(['view', 'click', 'like', 'dislike', 'signup', 'select_tags']),
  session_id: z.string().default(() => nanoid()),
  source: z.string().default('web'),
  duration_ms: z.number().int().optional(),
  page_depth: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional()
}).refine(
  (data) =>
    !(
      data.action === 'select_tags' &&
      (!data.tags || data.tags.length === 0)
    ),
  {
    message: "Tags array must be provided and non-empty for 'select_tags' action",
    path: ['tags'],
  }
);

// Query schemas for analytics
export const trendingEventsQuerySchema = z.object({
  category: z.string().optional(),
  location: z.string().optional(),
  hours: z.number().default(24),
  limit: z.number().default(20)
});

export const userBehaviorQuerySchema = z.object({
  user_id: z.string(),
  days: z.number().default(30)
});

export const locationTrendsQuerySchema = z.object({
  location: z.string(),
  days: z.number().default(7),
  limit: z.number().default(10)
});

// Response schemas
export const trendingEventResponseSchema = z.object({
  event_id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  interaction_count: z.number(),
  unique_users: z.number(),
  engagement_rate: z.number(),
  avg_duration_ms: z.number().nullable()
});

export const userBehaviorResponseSchema = z.object({
  user_id: z.string(),
  total_interactions: z.number(),
  unique_events: z.number(),
  avg_session_duration_ms: z.number(),
  preferred_categories: z.array(z.string()),
  engagement_score: z.number()
});

// Types for TypeScript
export type TinybirdEvent = z.infer<typeof tinybirdEventSchema>;
export type TinybirdInteraction = z.infer<typeof tinybirdInteractionSchema>;
export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type LogInteraction = z.infer<typeof logInteractionSchema>;
export type TrendingEventResponse = z.infer<typeof trendingEventResponseSchema>;
export type UserBehaviorResponse = z.infer<typeof userBehaviorResponseSchema>;