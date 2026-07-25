import { Tinybird, defineIngest } from '@vyr-e/tinykit';
import type { Context } from 'hono';
import type { EnvBindings } from '../types';
import { z } from 'zod';

import {
  eventsSchema,
  eventsDataSource,
  interactionsSchema,
  interactionsDataSource,
  ingestEventSchema,
  logInteractionSchema,
  trendingEventsQuerySchema,
  trendingEventResponseSchema,
  realtimeTrendingQuerySchema,
  realtimeTrendingResponseSchema,
  userBehaviorQuerySchema,
  userBehaviorResponseSchema,
  locationTrendsQuerySchema,
  locationTrendResponseSchema,
  eventSimilarityQuerySchema,
  eventSimilarityResponseSchema,
} from '../validation/tinybird-schemas';
import type {
  IngestEvent,
  LogInteraction,
} from '../validation/tinybird-schemas';

import {
  createTrendingEventsPipe,
  createEventSimilarityPipe,
  createUserBehaviorPipe,
  createRealtimeTrendingPipe,
  createLocationTrendsPipe,
} from './tinybird-pipes';

const luminClientConfig = {
  datasources: {
    events: eventsDataSource,
    interactions: interactionsDataSource,
  },
  pipes: {
    trendingEvents: createTrendingEventsPipe,
    eventSimilarity: createEventSimilarityPipe,
    userBehavior: createUserBehaviorPipe,
    realtimeTrending: createRealtimeTrendingPipe,
    locationTrends: createLocationTrendsPipe,
  },
};

export type LuminTinybirdClient = Tinybird<
  typeof luminClientConfig.datasources,
  typeof luminClientConfig.pipes
>;

export const getTinybirdClient = (
  c: Context<{ Bindings: EnvBindings }>
): LuminTinybirdClient => {
  return getTinybirdClientFromEnv(c.env);
};

export const getTinybirdClientFromEnv = (
  env: EnvBindings
): LuminTinybirdClient => {
  return new Tinybird({
    baseUrl: env.TINYBIRD_BASE_URL,
    token: env.TINYBIRD_TOKEN,
    ...luminClientConfig,
  });
};

const eventIngestDef = defineIngest({
  datasource: 'events__v1',
  schema: eventsSchema,
});

export const createEventIngestionEndpoint = (tb: LuminTinybirdClient) => {
  const ingest = tb.ingest(eventIngestDef);
  return async (eventData: IngestEvent) => {
    const validatedData = ingestEventSchema.parse(eventData);

    const completeData = {
      id: validatedData.id,
      created_at: Date.now(),
      updated_at: Date.now(),
      title: validatedData.title,
      tags: validatedData.tags,
      description: validatedData.description ?? null,
      host: validatedData.host ?? null,
      category: validatedData.category ?? null,
      image_url: validatedData.image_url ?? null,
      event_date: validatedData.event_date ?? null,
      location: validatedData.location ?? null,
      capacity: validatedData.capacity ?? null,
      price: validatedData.price ?? null,
      metadata: validatedData.metadata
        ? JSON.stringify(validatedData.metadata)
        : null,
    };
    return ingest([completeData]);
  };
};

const interactionIngestDef = defineIngest({
  datasource: 'interactions__v1',
  schema: interactionsSchema,
});

export const createInteractionIngestionEndpoint = (tb: LuminTinybirdClient) => {
  const ingest = tb.ingest(interactionIngestDef);
  return async (interactionData: LogInteraction) => {
    const validatedData = logInteractionSchema.parse(interactionData);

    const completeData = {
      id: validatedData.id,
      timestamp: Date.now(),
      user_id: validatedData.user_id,
      event_id: validatedData.event_id,
      action: validatedData.action,
      session_id: validatedData.session_id,
      source: validatedData.source,
      duration_ms: validatedData.duration_ms ?? null,
      tags: validatedData.tags ?? null,
      metadata: validatedData.metadata
        ? JSON.stringify(validatedData.metadata)
        : null,
    };

    return ingest([completeData]);
  };
};

export const createTrendingEventsQuery = (tb: LuminTinybirdClient) => {
  const queryPipe = tb.pipe({
    pipe: 'trending_events__v1',
    data: trendingEventResponseSchema,
  });

  return async (params: z.infer<typeof trendingEventsQuerySchema>) => {
    const validatedParams = trendingEventsQuerySchema.parse(params);
    return await queryPipe(validatedParams);
  };
};

export const createEventSimilarityQuery = (tb: LuminTinybirdClient) => {
  const queryPipe = tb.pipe({
    pipe: 'event_similarity__v1',
    data: eventSimilarityResponseSchema,
  });
  return async (params: z.infer<typeof eventSimilarityQuerySchema>) => {
    const validatedParams = eventSimilarityQuerySchema.parse(params);
    return await queryPipe(validatedParams);
  };
};

export const createUserBehaviorQuery = (tb: LuminTinybirdClient) => {
  const queryPipe = tb.pipe({
    pipe: 'user_behavior__v1',
    data: userBehaviorResponseSchema,
  });
  return async (params: z.infer<typeof userBehaviorQuerySchema>) => {
    const validatedParams = userBehaviorQuerySchema.parse(params);
    return await queryPipe(validatedParams);
  };
};

export const createRealtimeTrendingQuery = (tb: LuminTinybirdClient) => {
  const queryPipe = tb.pipe({
    pipe: 'realtime_trending__v1',
    data: realtimeTrendingResponseSchema,
  });
  return async (params: z.infer<typeof realtimeTrendingQuerySchema>) => {
    const validatedParams = realtimeTrendingQuerySchema.parse(params);
    return await queryPipe(validatedParams);
  };
};

export const createLocationTrendsQuery = (tb: LuminTinybirdClient) => {
  const queryPipe = tb.pipe({
    pipe: 'location_trends__v1',
    data: locationTrendResponseSchema,
  });
  return async (params: z.infer<typeof locationTrendsQuerySchema>) => {
    const validatedParams = locationTrendsQuerySchema.parse(params);
    return await queryPipe(validatedParams);
  };
};
