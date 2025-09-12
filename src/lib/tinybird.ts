import { Tinybird } from '@chronark/zod-bird';
import type { Context } from 'hono';
import type { EnvBindings } from '../types';
import {
  tinybirdEventSchema,
  tinybirdInteractionSchema,
  trendingEventsQuerySchema,
  trendingEventResponseSchema,
  userBehaviorQuerySchema,
  userBehaviorResponseSchema,
  locationTrendsQuerySchema,
} from '../validation/tinybird-schemas';

export const getTinybirdClient = (
  c: Context<{ Bindings: EnvBindings }>
): Tinybird => {
  return new Tinybird({
    token: c.env.TINYBIRD_TOKEN,
    baseUrl: c.env.TINYBIRD_BASE_URL || 'https://api.tinybird.co',
  });
};

// Event ingestion endpoint
export const createEventIngestionEndpoint = (tb: Tinybird) => {
  return tb.buildIngestEndpoint({
    datasource: 'events__v1',
    event: tinybirdEventSchema,
  });
};

// Interaction ingestion endpoint
export const createInteractionIngestionEndpoint = (tb: Tinybird) => {
  return tb.buildIngestEndpoint({
    datasource: 'interactions__v1',
    event: tinybirdInteractionSchema,
  });
};

// Analytics query endpoints
export const createTrendingEventsQuery = (tb: Tinybird) => {
  return tb.buildPipe({
    pipe: 'trending_events__v1',
    parameters: trendingEventsQuerySchema,
    data: trendingEventResponseSchema,
    opts: {
      cache: 'no-store', // Real-time data
    },
  });
};

export const createUserBehaviorQuery = (tb: Tinybird) => {
  return tb.buildPipe({
    pipe: 'user_behavior__v1',
    parameters: userBehaviorQuerySchema,
    data: userBehaviorResponseSchema,
    opts: {
      revalidate: 3600, // Cache for 1 hour
    },
  });
};

export const createLocationTrendsQuery = (tb: Tinybird) => {
  return tb.buildPipe({
    pipe: 'location_trends__v1',
    parameters: locationTrendsQuerySchema,
    data: trendingEventResponseSchema,
    opts: {
      revalidate: 1800, // Cache for 30 minutes
    },
  });
};

// Event similarity query for recommendations
export const createEventSimilarityQuery = (tb: Tinybird) => {
  return tb.buildPipe({
    pipe: 'event_similarity__v1',
    parameters: {
      event_ids: ['string'], // Array of event IDs
      limit: 20,
    },
    data: {
      event_id: 'string',
      title: 'string',
      category: 'string',
      similarity_score: 'number',
    },
    opts: {
      revalidate: 900, // Cache for 15 minutes
    },
  });
};

// Real-time trending for exploration
export const createRealtimeTrendingQuery = (tb: Tinybird) => {
  return tb.buildPipe({
    pipe: 'realtime_trending__v1',
    parameters: {
      minutes: 60, // Last N minutes
      limit: 10,
    },
    data: {
      event_id: 'string',
      title: 'string',
      interaction_velocity: 'number', // Interactions per minute
      engagement_score: 'number',
    },
    opts: {
      cache: 'no-store', // Always fresh for trending
    },
  });
};

// User interaction patterns for collaborative filtering
export const createUserInteractionPatternsQuery = (tb: Tinybird) => {
  return tb.buildPipe({
    pipe: 'user_interaction_patterns__v1',
    parameters: {
      user_id: 'string',
      days: 30,
    },
    data: {
      user_id: 'string',
      similar_users: ['string'], // Array of similar user IDs
      common_events: ['string'], // Events they both interacted with
      similarity_score: 'number',
    },
    opts: {
      revalidate: 7200, // Cache for 2 hours
    },
  });
};