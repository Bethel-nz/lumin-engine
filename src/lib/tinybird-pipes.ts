import {
  definePipe,
  defineParameters,
  int64Param,
  stringParam,
  query,
  count,
} from '@vyr-e/tinykit';
import {
  interactionsSchema,
  eventsSchema,
} from '../validation/tinybird-schemas';

// Pipe to get trending events
export const createTrendingEventsPipe = definePipe({
  name: 'trending_events__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    limit: int64Param('limit', { default: 10 }),
    hours: int64Param('hours', { default: 24 }),
    category: stringParam('category', { default: '' }),
  }),
}).endpoint((_q, _params, tpl) =>
  query(interactionsSchema)
    .with(
      'interactions',
      query(interactionsSchema)
        .selectRaw(
          'id, any(user_id) AS user_id, any(event_id) AS event_id, any(action) AS action, max(timestamp) AS timestamp'
        )
        .from('interactions__v1')
        .groupBy('id')
    )
    .with(
      'events',
      query(eventsSchema)
        .selectRaw(
          'id, argMax(title, updated_at) AS title, argMax(category, updated_at) AS category'
        )
        .from('events__v1')
        .groupBy('id')
    )
    .selectRaw(
      `interactions.event_id AS event_id, any(events.title) AS title, any(events.category) AS category, ${count()} AS interaction_count, countIf(interactions.action IN ('like', 'click')) / greatest(${count()}, 1) AS engagement_rate`
    )
    .from('interactions')
    .join('events', 'events.id = interactions.event_id', 'INNER')
    .where(
      `interactions.timestamp >= toUnixTimestamp64Milli(now64(3) - INTERVAL ${tpl.hours} HOUR)`
    )
    .and(`(${tpl.category} = '' OR events.category = ${tpl.category})`)
    .groupBy('interactions.event_id')
    .orderBy('engagement_rate DESC', 'interaction_count DESC')
    .limit(tpl.limit)
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
    WITH
      (
        SELECT argMax(tags, updated_at)
        FROM events__v1
        WHERE id = {{ String(event_id, required=True) }}
      ) AS target_tags
    SELECT
      id AS event_id,
      argMax(title, updated_at) AS title,
      argMax(category, updated_at) AS category,
      length(arrayIntersect(argMax(tags, updated_at), target_tags))
        / greatest(
            length(arrayDistinct(arrayConcat(argMax(tags, updated_at), target_tags))),
            1
          ) AS similarity_score
    FROM events__v1
    WHERE id != {{ String(event_id, required=True) }}
    GROUP BY id
    HAVING similarity_score > 0
    ORDER BY similarity_score DESC
    LIMIT {{ Int64(limit, 20) }}
  `
);

// Pipe to get user behavior trends
export const createUserBehaviorPipe = definePipe({
  name: 'user_behavior__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    user_id: stringParam('user_id', { required: true }),
    days: int64Param('days', { default: 7 }),
  }),
}).raw(
  `
    SELECT groupArray(category) AS preferred_categories
    FROM
    (
      SELECT
        any(events.category) AS category,
        count() AS interaction_count
      FROM
      (
        SELECT id, any(user_id) AS user_id, any(event_id) AS event_id,
               any(action) AS action, max(timestamp) AS timestamp
        FROM interactions__v1
        GROUP BY id
      ) AS interactions
      INNER JOIN
      (
        SELECT id, argMax(category, updated_at) AS category
        FROM events__v1
        GROUP BY id
      ) AS events ON events.id = interactions.event_id
      WHERE interactions.user_id = {{ String(user_id, required=True) }}
        AND interactions.action IN ('view', 'click', 'like')
        AND interactions.timestamp >= toUnixTimestamp64Milli(
          now64(3) - INTERVAL {{ Int64(days, 7) }} DAY
        )
        AND events.category != ''
      GROUP BY events.category
      ORDER BY interaction_count DESC
    )
  `
);

// Pipe to get realtime trending events
export const createRealtimeTrendingPipe = definePipe({
  name: 'realtime_trending__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    limit: int64Param('limit', { default: 10 }),
    minutes: int64Param('minutes', { default: 60 }),
  }),
}).raw(
  `
    SELECT
      event_id,
      count() / greatest({{ Int64(minutes, 60) }}, 1) AS interaction_velocity,
      sum(
        multiIf(
          action = 'like', 2.0,
          action = 'click', 1.0,
          action = 'view', 0.5,
          action = 'dislike', -1.0,
          0.0
        )
      ) AS engagement_score
    FROM
    (
      SELECT id, any(event_id) AS event_id, any(action) AS action,
             max(timestamp) AS timestamp
      FROM interactions__v1
      GROUP BY id
    )
    WHERE timestamp >= toUnixTimestamp64Milli(
      now64(3) - INTERVAL {{ Int64(minutes, 60) }} MINUTE
    )
    GROUP BY event_id
    ORDER BY engagement_score DESC, interaction_velocity DESC
    LIMIT {{ Int64(limit, 10) }}
  `
);

// Pipe to get location trends
export const createLocationTrendsPipe = definePipe({
  name: 'location_trends__v1',
  schema: interactionsSchema,
  parameters: defineParameters({
    location: stringParam('location', { required: true }),
    limit: int64Param('limit', { default: 10 }),
    days: int64Param('days', { default: 7 }),
  }),
}).raw(
  `
    SELECT
      interactions.event_id AS event_id,
      count() AS interaction_count,
      countIf(interactions.action IN ('like', 'click')) / greatest(count(), 1) AS engagement_rate
    FROM
    (
      SELECT id, any(event_id) AS event_id, any(action) AS action,
             max(timestamp) AS timestamp
      FROM interactions__v1
      GROUP BY id
    ) AS interactions
    INNER JOIN
    (
      SELECT id, argMax(location, updated_at) AS location
      FROM events__v1
      GROUP BY id
    ) AS events ON events.id = interactions.event_id
    WHERE events.location = {{ String(location, required=True) }}
      AND interactions.timestamp >= toUnixTimestamp64Milli(
        now64(3) - INTERVAL {{ Int64(days, 7) }} DAY
      )
    GROUP BY interactions.event_id
    ORDER BY engagement_rate DESC, interaction_count DESC
    LIMIT {{ Int64(limit, 10) }}
  `
);
