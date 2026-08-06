import { z } from 'zod';
import {
  array,
  defineDataSource,
  defineSchema,
  int64,
  nullable,
  string,
} from '@vyr-e/tinykit';

export const itemsSchema = defineSchema({
  tenant_id: string('tenant_id'),
  catalog_id: string('catalog_id'),
  item_id: string('item_id'),
  title: string('title'),
  description: nullable('description', z.string(), { innerType: 'String' }),
  tags: array('tags', z.string(), { innerType: 'String' }),
  category: nullable('category', z.string(), { innerType: 'String' }),
  image_url: nullable('image_url', z.string(), { innerType: 'String' }),
  price: nullable('price', z.number(), { innerType: 'Float64' }),
  attributes: string('attributes'),
  created_at: int64('created_at'),
  updated_at: int64('updated_at'),
});

export const itemsDataSource = defineDataSource({
  name: 'items__v1',
  schema: itemsSchema,
  engine: 'MergeTree',
  sortingKey: ['tenant_id', 'catalog_id', 'created_at', 'item_id'],
});

export const catalogInteractionsSchema = defineSchema({
  id: string('id'),
  tenant_id: string('tenant_id'),
  catalog_id: string('catalog_id'),
  user_id: string('user_id'),
  item_id: string('item_id'),
  action: string('action'),
  session_id: string('session_id'),
  source: string('source'),
  duration_ms: nullable('duration_ms', z.number().int(), {
    innerType: 'Int64',
  }),
  timestamp: int64('timestamp'),
  metadata: nullable('metadata', z.string(), { innerType: 'String' }),
});

export const catalogInteractionsDataSource = defineDataSource({
  name: 'interactions__v1',
  schema: catalogInteractionsSchema,
  engine: 'MergeTree',
  sortingKey: [
    'tenant_id',
    'catalog_id',
    'timestamp',
    'user_id',
    'item_id',
  ],
});

export const trendingItemsQuerySchema = z.object({
  tenant_id: z.string().min(1),
  catalog_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  hours: z.number().int().positive().default(168),
  category: z.string().default(''),
});

export const trendingItemResponseSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  interaction_count: z.number(),
  engagement_score: z.number(),
});

export const realtimeTrendingQuerySchema = z.object({
  tenant_id: z.string().min(1),
  catalog_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  minutes: z.number().int().positive().default(60),
});

export const realtimeTrendingResponseSchema = z.object({
  item_id: z.string(),
  interaction_velocity: z.number(),
  engagement_score: z.number(),
});

export const userBehaviorQuerySchema = z.object({
  tenant_id: z.string().min(1),
  catalog_id: z.string().min(1),
  user_id: z.string().min(1),
  days: z.number().int().positive().default(30),
});

export const userBehaviorResponseSchema = z.object({
  preferred_categories: z.array(z.string()),
});

export const userInteractionsQuerySchema = z.object({
  tenant_id: z.string().min(1),
  catalog_id: z.string().min(1),
  user_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(200),
});

export const userInteractionResponseSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  action: z.string(),
  interaction_timestamp: z.number(),
});

export const itemSimilarityQuerySchema = z.object({
  tenant_id: z.string().min(1),
  catalog_id: z.string().min(1),
  item_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
});

export const itemSimilarityResponseSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  similarity_score: z.number(),
});

export const facetTrendsQuerySchema = z.object({
  tenant_id: z.string().min(1),
  catalog_id: z.string().min(1),
  facet: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  days: z.number().int().positive().default(7),
});

export const facetTrendResponseSchema = z.object({
  item_id: z.string(),
  interaction_count: z.number(),
  engagement_score: z.number(),
});
