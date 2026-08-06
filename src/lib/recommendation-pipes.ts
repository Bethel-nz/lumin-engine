import {
  count,
  defineParameters,
  definePipe,
  int64Param,
  query,
  stringParam,
} from '@vyr-e/tinykit';
import {
  catalogInteractionsSchema,
  itemsSchema,
} from '../validation/recommendation-tinybird-schemas';

const engagementScore = (action: string) => `sum(
  multiIf(
    ${action} = 'complete', 3.0,
    ${action} = 'purchase', 3.0,
    ${action} = 'like', 2.0,
    ${action} = 'save', 1.5,
    ${action} = 'click', 1.0,
    ${action} = 'view', 0.25,
    ${action} = 'dismiss', -1.0,
    ${action} = 'dislike', -2.0,
    0.0
  )
)`;

export const trendingItemsPipe = definePipe({
  name: 'trending_items__v1',
  schema: catalogInteractionsSchema,
  parameters: defineParameters({
    tenant_id: stringParam('tenant_id', { required: true }),
    catalog_id: stringParam('catalog_id', { required: true }),
    limit: int64Param('limit', { default: 20 }),
    hours: int64Param('hours', { default: 168 }),
    category: stringParam('category', { default: '' }),
  }),
}).endpoint((_q, _params, tpl) =>
  query(catalogInteractionsSchema)
    .with(
      'deduped_interactions',
      query(catalogInteractionsSchema)
        .selectRaw(
          'id, any(tenant_id) AS tenant_id, any(catalog_id) AS catalog_id, any(item_id) AS item_id, any(action) AS action, max(timestamp) AS timestamp'
        )
        .from('interactions__v1')
        .groupBy('id')
    )
    .with(
      'latest_items',
      query(itemsSchema)
        .selectRaw(
          'tenant_id, catalog_id, item_id, argMax(title, updated_at) AS title, argMax(category, updated_at) AS category'
        )
        .from('items__v1')
        .groupBy('tenant_id', 'catalog_id', 'item_id')
    )
    .selectRaw(
      `deduped_interactions.item_id AS item_id, any(latest_items.title) AS title, any(latest_items.category) AS category, ${count()} AS interaction_count, ${engagementScore('deduped_interactions.action')} AS engagement_score`
    )
    .from('deduped_interactions')
    .join(
      'latest_items',
      'latest_items.tenant_id = deduped_interactions.tenant_id AND latest_items.catalog_id = deduped_interactions.catalog_id AND latest_items.item_id = deduped_interactions.item_id',
      'INNER'
    )
    .where(`deduped_interactions.tenant_id = ${tpl.tenant_id}`)
    .and(`deduped_interactions.catalog_id = ${tpl.catalog_id}`)
    .and(
      `deduped_interactions.timestamp >= toUnixTimestamp64Milli(now64(3) - INTERVAL ${tpl.hours} HOUR)`
    )
    .and(`(${tpl.category} = '' OR latest_items.category = ${tpl.category})`)
    .groupBy('deduped_interactions.item_id')
    .having('engagement_score > 0')
    .orderBy('engagement_score DESC', 'interaction_count DESC')
    .limit(tpl.limit)
);

export const realtimeTrendingPipe = definePipe({
  name: 'realtime_trending__v1',
  schema: catalogInteractionsSchema,
  parameters: defineParameters({
    tenant_id: stringParam('tenant_id', { required: true }),
    catalog_id: stringParam('catalog_id', { required: true }),
    limit: int64Param('limit', { default: 20 }),
    minutes: int64Param('minutes', { default: 60 }),
  }),
}).endpoint((_q, _params, tpl) =>
  query(catalogInteractionsSchema)
    .with(
      'deduped_interactions',
      query(catalogInteractionsSchema)
        .selectRaw(
          'id, any(tenant_id) AS tenant_id, any(catalog_id) AS catalog_id, any(item_id) AS item_id, any(action) AS action, max(timestamp) AS timestamp'
        )
        .from('interactions__v1')
        .groupBy('id')
    )
    .selectRaw(
      `item_id, count() / greatest(${tpl.minutes}, 1) AS interaction_velocity, ${engagementScore('action')} AS engagement_score`
    )
    .from('deduped_interactions')
    .where(`tenant_id = ${tpl.tenant_id}`)
    .and(`catalog_id = ${tpl.catalog_id}`)
    .and(
      `timestamp >= toUnixTimestamp64Milli(now64(3) - INTERVAL ${tpl.minutes} MINUTE)`
    )
    .groupBy('item_id')
    .orderBy('engagement_score DESC', 'interaction_velocity DESC')
    .limit(tpl.limit)
);

export const userBehaviorPipe = definePipe({
  name: 'user_behavior__v1',
  schema: catalogInteractionsSchema,
  parameters: defineParameters({
    tenant_id: stringParam('tenant_id', { required: true }),
    catalog_id: stringParam('catalog_id', { required: true }),
    user_id: stringParam('user_id', { required: true }),
    days: int64Param('days', { default: 30 }),
  }),
}).endpoint((_q, _params, tpl) =>
  query(catalogInteractionsSchema)
    .selectRaw(`groupArray(category) AS preferred_categories`)
    .from(`(
      SELECT
        any(latest_items.category) AS category,
        count() AS interaction_count
      FROM (
        SELECT id, any(tenant_id) AS tenant_id, any(catalog_id) AS catalog_id,
               any(user_id) AS user_id, any(item_id) AS item_id,
               any(action) AS action, max(timestamp) AS timestamp
        FROM interactions__v1
        GROUP BY id
      ) AS interactions
      INNER JOIN (
        SELECT tenant_id, catalog_id, item_id,
               argMax(category, updated_at) AS category
        FROM items__v1
        GROUP BY tenant_id, catalog_id, item_id
      ) AS latest_items
        ON latest_items.tenant_id = interactions.tenant_id
       AND latest_items.catalog_id = interactions.catalog_id
       AND latest_items.item_id = interactions.item_id
      WHERE interactions.tenant_id = ${tpl.tenant_id}
        AND interactions.catalog_id = ${tpl.catalog_id}
        AND interactions.user_id = ${tpl.user_id}
        AND interactions.action IN ('view', 'click', 'like', 'save', 'complete', 'purchase')
        AND interactions.timestamp >= toUnixTimestamp64Milli(
          now64(3) - INTERVAL ${tpl.days} DAY
        )
        AND latest_items.category != ''
      GROUP BY latest_items.category
      ORDER BY interaction_count DESC
    )`)
);

export const userInteractionsPipe = definePipe({
  name: 'user_interactions__v1',
  schema: catalogInteractionsSchema,
  parameters: defineParameters({
    tenant_id: stringParam('tenant_id', { required: true }),
    catalog_id: stringParam('catalog_id', { required: true }),
    user_id: stringParam('user_id', { required: true }),
    limit: int64Param('limit', { default: 200 }),
  }),
}).endpoint((_q, _params, tpl) =>
  query(catalogInteractionsSchema)
    .selectRaw(
      'id, argMax(item_id, timestamp) AS item_id, argMax(action, timestamp) AS action, max(timestamp) AS interaction_timestamp'
    )
    .from('interactions__v1')
    .where(`tenant_id = ${tpl.tenant_id}`)
    .and(`catalog_id = ${tpl.catalog_id}`)
    .and(`user_id = ${tpl.user_id}`)
    .groupBy('id')
    .orderBy('interaction_timestamp DESC')
    .limit(tpl.limit)
);

export const itemSimilarityPipe = definePipe({
  name: 'item_similarity__v1',
  schema: itemsSchema,
  parameters: defineParameters({
    tenant_id: stringParam('tenant_id', { required: true }),
    catalog_id: stringParam('catalog_id', { required: true }),
    item_id: stringParam('item_id', { required: true }),
    limit: int64Param('limit', { default: 20 }),
  }),
}).endpoint((_q, _params, tpl) => {
  const targetTags = `(
    SELECT argMax(tags, updated_at)
    FROM items__v1
    WHERE tenant_id = ${tpl.tenant_id}
      AND catalog_id = ${tpl.catalog_id}
      AND item_id = ${tpl.item_id}
  )`;

  return query(itemsSchema)
    .selectRaw(
      `item_id, argMax(title, updated_at) AS title, argMax(category, updated_at) AS category, length(arrayIntersect(argMax(tags, updated_at), ${targetTags})) / greatest(length(arrayDistinct(arrayConcat(argMax(tags, updated_at), ${targetTags}))), 1) AS similarity_score`
    )
    .from('items__v1')
    .where(`tenant_id = ${tpl.tenant_id}`)
    .and(`catalog_id = ${tpl.catalog_id}`)
    .and(`item_id != ${tpl.item_id}`)
    .groupBy('item_id')
    .having('similarity_score > 0')
    .orderBy('similarity_score DESC')
    .limit(tpl.limit);
});

export const facetTrendsPipe = definePipe({
  name: 'facet_trends__v1',
  schema: catalogInteractionsSchema,
  parameters: defineParameters({
    tenant_id: stringParam('tenant_id', { required: true }),
    catalog_id: stringParam('catalog_id', { required: true }),
    facet: stringParam('facet', { required: true }),
    value: stringParam('value', { required: true }),
    limit: int64Param('limit', { default: 20 }),
    days: int64Param('days', { default: 7 }),
  }),
}).endpoint((_q, _params, tpl) =>
  query(catalogInteractionsSchema)
    .with(
      'deduped_interactions',
      query(catalogInteractionsSchema)
        .selectRaw(
          'id, any(tenant_id) AS tenant_id, any(catalog_id) AS catalog_id, any(item_id) AS item_id, any(action) AS action, max(timestamp) AS timestamp'
        )
        .from('interactions__v1')
        .groupBy('id')
    )
    .with(
      'latest_items',
      query(itemsSchema)
        .selectRaw(
          'tenant_id, catalog_id, item_id, argMax(attributes, updated_at) AS attributes'
        )
        .from('items__v1')
        .groupBy('tenant_id', 'catalog_id', 'item_id')
    )
    .selectRaw(
      `deduped_interactions.item_id AS item_id, count() AS interaction_count, ${engagementScore('deduped_interactions.action')} AS engagement_score`
    )
    .from('deduped_interactions')
    .join(
      'latest_items',
      'latest_items.tenant_id = deduped_interactions.tenant_id AND latest_items.catalog_id = deduped_interactions.catalog_id AND latest_items.item_id = deduped_interactions.item_id',
      'INNER'
    )
    .where(`deduped_interactions.tenant_id = ${tpl.tenant_id}`)
    .and(`deduped_interactions.catalog_id = ${tpl.catalog_id}`)
    .and(
      `JSONExtractString(latest_items.attributes, ${tpl.facet}) = ${tpl.value}`
    )
    .and(
      `deduped_interactions.timestamp >= toUnixTimestamp64Milli(now64(3) - INTERVAL ${tpl.days} DAY)`
    )
    .groupBy('deduped_interactions.item_id')
    .having('engagement_score > 0')
    .orderBy('engagement_score DESC', 'interaction_count DESC')
    .limit(tpl.limit)
);
