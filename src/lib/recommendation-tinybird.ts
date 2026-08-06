import { Tinybird, defineIngest } from '@vyr-e/tinykit';
import type { EnvBindings } from '../types';
import type {
  CatalogInteractionInput,
  CatalogItemInput,
} from '../validation/recommendation-schemas';
import {
  catalogAnalyticsQuerySchema,
  catalogAnalyticsResponseSchema,
  catalogInteractionsDataSource,
  catalogInteractionsSchema,
  facetTrendResponseSchema,
  facetTrendsQuerySchema,
  itemSimilarityQuerySchema,
  itemSimilarityResponseSchema,
  itemsDataSource,
  itemsSchema,
  realtimeTrendingQuerySchema,
  realtimeTrendingResponseSchema,
  trendingItemResponseSchema,
  trendingItemsQuerySchema,
  userBehaviorQuerySchema,
  userBehaviorResponseSchema,
  userInteractionResponseSchema,
  userInteractionsQuerySchema,
} from '../validation/recommendation-tinybird-schemas';
import {
  catalogAnalyticsPipe,
  facetTrendsPipe,
  itemSimilarityPipe,
  realtimeTrendingPipe,
  trendingItemsPipe,
  userBehaviorPipe,
  userInteractionsPipe,
} from './recommendation-pipes';

const config = {
  datasources: {
    items: itemsDataSource,
    interactions: catalogInteractionsDataSource,
  },
  pipes: {
    catalogAnalytics: catalogAnalyticsPipe,
    trendingItems: trendingItemsPipe,
    realtimeTrending: realtimeTrendingPipe,
    userBehavior: userBehaviorPipe,
    userInteractions: userInteractionsPipe,
    itemSimilarity: itemSimilarityPipe,
    facetTrends: facetTrendsPipe,
  },
};

export type RecommendationTinybirdClient = Tinybird<
  typeof config.datasources,
  typeof config.pipes
>;

export const getRecommendationTinybirdClient = (
  c: { env: EnvBindings }
) =>
  new Tinybird({
    baseUrl: c.env.TINYBIRD_BASE_URL,
    token: c.env.TINYBIRD_TOKEN,
    ...config,
  }) as RecommendationTinybirdClient;

const itemIngestDefinition = defineIngest({
  datasource: 'items__v1',
  schema: itemsSchema,
});

export const createItemIngestion = (tb: RecommendationTinybirdClient) => {
  const ingest = tb.ingest(itemIngestDefinition);

  return (
    tenantId: string,
    catalogId: string,
    item: CatalogItemInput,
    now: number
  ) =>
    ingest([
      {
        tenant_id: tenantId,
        catalog_id: catalogId,
        item_id: item.item_id,
        title: item.title,
        description: item.description ?? null,
        tags: item.tags,
        category: item.category ?? null,
        image_url: item.image_url ?? null,
        price: item.price ?? null,
        attributes: JSON.stringify(item.attributes),
        created_at: now,
        updated_at: now,
      },
    ]);
};

const interactionIngestDefinition = defineIngest({
  datasource: 'interactions__v1',
  schema: catalogInteractionsSchema,
});

export const createCatalogInteractionIngestion = (
  tb: RecommendationTinybirdClient
) => {
  const ingest = tb.ingest(interactionIngestDefinition);

  return (
    tenantId: string,
    catalogId: string,
    interaction: CatalogInteractionInput & { id: string },
    now: number
  ) =>
    ingest([
      {
        id: interaction.id,
        tenant_id: tenantId,
        catalog_id: catalogId,
        user_id: interaction.user_id,
        item_id: interaction.item_id,
        action: interaction.action,
        session_id: interaction.session_id,
        source: interaction.source,
        duration_ms: interaction.duration_ms ?? null,
        timestamp: now,
        metadata: interaction.metadata
          ? JSON.stringify(interaction.metadata)
          : null,
      },
    ]);
};

export const createTrendingItemsQuery = (tb: RecommendationTinybirdClient) => {
  const endpoint = tb.pipe({
    pipe: 'trending_items__v1',
    data: trendingItemResponseSchema,
  });
  return (params: unknown) => endpoint(trendingItemsQuerySchema.parse(params));
};

export const createRealtimeTrendingQuery = (
  tb: RecommendationTinybirdClient
) => {
  const endpoint = tb.pipe({
    pipe: 'realtime_trending__v1',
    data: realtimeTrendingResponseSchema,
  });
  return (params: unknown) =>
    endpoint(realtimeTrendingQuerySchema.parse(params));
};

export const createCatalogAnalyticsQuery = (
  tb: RecommendationTinybirdClient
) => {
  const endpoint = tb.pipe({
    pipe: 'catalog_analytics__v1',
    data: catalogAnalyticsResponseSchema,
  });
  return (params: unknown) => endpoint(catalogAnalyticsQuerySchema.parse(params));
};

export const createUserBehaviorQuery = (tb: RecommendationTinybirdClient) => {
  const endpoint = tb.pipe({
    pipe: 'user_behavior__v1',
    data: userBehaviorResponseSchema,
  });
  return (params: unknown) => endpoint(userBehaviorQuerySchema.parse(params));
};

export const createUserInteractionsQuery = (
  tb: RecommendationTinybirdClient
) => {
  const endpoint = tb.pipe({
    pipe: 'user_interactions__v1',
    data: userInteractionResponseSchema,
  });
  return (params: unknown) =>
    endpoint(userInteractionsQuerySchema.parse(params));
};

export const createItemSimilarityQuery = (
  tb: RecommendationTinybirdClient
) => {
  const endpoint = tb.pipe({
    pipe: 'item_similarity__v1',
    data: itemSimilarityResponseSchema,
  });
  return (params: unknown) => endpoint(itemSimilarityQuerySchema.parse(params));
};

export const createFacetTrendsQuery = (tb: RecommendationTinybirdClient) => {
  const endpoint = tb.pipe({
    pipe: 'facet_trends__v1',
    data: facetTrendResponseSchema,
  });
  return (params: unknown) => endpoint(facetTrendsQuerySchema.parse(params));
};
