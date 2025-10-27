import {
  definePipe,
  defineParameters,
  int64Param,
  stringParam,
  query,
  count,
  param,
} from '@vyr-e/tinykit';
import {
  interactionsSchema,
  eventsSchema,
} from '../validation/tinybird-schemas';

// Pipe to get trending events
export const createTrendingEventsPipe = definePipe({
  name: 'trending_events__v1',
  schema: interactionsSchema, // The primary table for the query
  parameters: defineParameters({
    limit: int64Param('limit', { default: 10 }),
    days: int64Param('days', { default: 7 }),
  }),
}).endpoint((q, params) =>
  query(interactionsSchema)
    .selectRaw(
      `
        event_id,
        any(events.title) as title,
        any(events.category) as category,
        ${count()} as score
    `
    )
    .from('interactions__v1')
    .join('events__v1 as events', `events.id = interactions__v1.event_id`)
    .where(`timestamp >= now() - INTERVAL ${param('days', 'Int64')} DAY`)
    .groupBy('event_id')
    .orderBy('score DESC')
    .limit(params.limit)
);

// Pipe to get events similar to another event
export const createEventSimilarityPipe = definePipe({
  name: 'event_similarity__v1',
  schema: eventsSchema,
  parameters: defineParameters({
    event_id: stringParam('event_id', { required: true }),
    limit: int64Param('limit', { default: 20 }),
  }),
}).raw(
  `
    SELECT
        id as event_id,
        title,
        category,
        rand() / 100 as similarity_score
    FROM events__v1
    WHERE id != {{ String(event_id, required=True) }}
    LIMIT {{ Int64(limit, 20) }}
`
);

// Pipe to get user behavior trends
export const createUserBehaviorPipe = definePipe({
  name: 'user_behavior__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    limit: int64Param('limit', { default: 10 }),
    days: int64Param('days', { default: 7 }),
  }),
}).endpoint((q, params) =>
  query(interactionsSchema)
    .selectRaw(
      `
        event_id,
        any(events.title) as title,
        any(events.category) as category,
        ${count()} as score
    `
    )
    .from('interactions__v1')
    .join('events__v1 as events', `events.id = interactions__v1.event_id`)
    .where(`timestamp >= now() - INTERVAL ${param('days', 'Int64')} DAY`)
    .groupBy('event_id')
    .orderBy('score DESC')
    .limit(params.limit)
);

// Pipe to get realtime trending events
export const createRealtimeTrendingPipe = definePipe({
  name: 'realtime_trending__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    limit: int64Param('limit', { default: 10 }),
    days: int64Param('days', { default: 7 }),
  }),
}).endpoint((q, params) =>
  query(interactionsSchema)
    .selectRaw(
      `
        event_id,
        any(events.title) as title,
        any(events.category) as category,
        ${count()} as score
    `
    )
    .from('interactions__v1')
    .join('events__v1 as events', `events.id = interactions__v1.event_id`)
    .where(`timestamp >= now() - INTERVAL ${param('days', 'Int64')} DAY`)
    .groupBy('event_id')
    .orderBy('score DESC')
    .limit(params.limit)
);

// Pipe to get location trends
export const createLocationTrendsPipe = definePipe({
  name: 'location_trends__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    limit: int64Param('limit', { default: 10 }),
    days: int64Param('days', { default: 7 }),
  }),
}).endpoint((q, params) =>
  query(interactionsSchema)
    .selectRaw(
      `
        event_id,
        any(events.title) as title,
        any(events.category) as category,
        ${count()} as score
    `
    )
    .from('interactions__v1')
    .join('events__v1 as events', `events.id = interactions__v1.event_id`)
    .where(`timestamp >= now() - INTERVAL ${param('days', 'Int64')} DAY`)
    .groupBy('event_id')
    .orderBy('score DESC')
    .limit(params.limit)
);
