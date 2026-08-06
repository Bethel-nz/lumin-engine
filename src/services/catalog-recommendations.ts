import type { Context } from 'hono';
import { CONFIG } from '../config';
import {
  getCatalogVectorIndex,
  getEmbeddingClient,
} from '../lib/clients';
import {
  drainCatalogOutbox,
  persistCatalogInteractionWithOutbox,
  persistCatalogItemWithOutbox,
} from './catalog-outbox';
import type { AppVariables, EnvBindings } from '../types';
import type {
  CatalogInteractionInput,
  CatalogItemInput,
} from '../validation/recommendation-schemas';
import type { Catalog } from './catalogs';
import { generateEmbedding, generateMultimodalEmbedding } from './vector';

type AppContext = Context<{
  Bindings: EnvBindings;
  Variables: AppVariables;
}>;

export interface CatalogItemRecord extends CatalogItemInput {
  tenant_id: string;
  catalog_id: string;
  created_at: number;
  updated_at: number;
}

interface CatalogItemRow {
  tenant_id: string;
  catalog_id: string;
  item_id: string;
  title: string;
  description: string | null;
  tags: string;
  category: string | null;
  image_url: string | null;
  price: number | null;
  attributes: string;
  created_at: number;
  updated_at: number;
}

interface InteractionRow {
  item_id: string;
  action: string;
  weight: number;
  timestamp: number;
}

const toItem = (row: CatalogItemRow): CatalogItemRecord => ({
  tenant_id: row.tenant_id,
  catalog_id: row.catalog_id,
  item_id: row.item_id,
  title: row.title,
  description: row.description ?? undefined,
  tags: JSON.parse(row.tags) as string[],
  category: row.category ?? undefined,
  image_url: row.image_url ?? undefined,
  price: row.price ?? undefined,
  attributes: JSON.parse(row.attributes) as Record<string, unknown>,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const readField = (
  item: CatalogItemInput,
  field: string
): unknown => {
  if (field in item && field !== 'attributes') {
    return item[field as keyof Omit<CatalogItemInput, 'attributes'>];
  }
  return item.attributes[field];
};

const stringifyEmbeddingValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.join(' ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export const buildCatalogEmbeddingInput = (
  catalog: Catalog,
  item: CatalogItemInput
) => {
  const text = catalog.embedConfig.text_fields
    .map((field) => stringifyEmbeddingValue(readField(item, field)))
    .filter(Boolean)
    .join(' ')
    .trim() || item.title;

  const imageValue = catalog.embedConfig.image_field
    ? readField(item, catalog.embedConfig.image_field)
    : item.image_url;

  return {
    text,
    imageUrl: typeof imageValue === 'string' ? imageValue : undefined,
  };
};

export const getCatalogItem = async (
  db: D1Database,
  tenantId: string,
  catalogId: string,
  itemId: string
): Promise<CatalogItemRecord | null> => {
  const row = await db
    .prepare(
      `SELECT tenant_id, catalog_id, item_id, title, description, tags,
              category, image_url, price, attributes, created_at, updated_at
       FROM catalog_items
       WHERE tenant_id = ? AND catalog_id = ? AND item_id = ?`
    )
    .bind(tenantId, catalogId, itemId)
    .first<CatalogItemRow>();

  return row ? toItem(row) : null;
};

export const listCatalogItems = async (
  db: D1Database,
  tenantId: string,
  catalogId: string,
  limit = 50
): Promise<CatalogItemRecord[]> => {
  const result = await db
    .prepare(
      `SELECT tenant_id, catalog_id, item_id, title, description, tags,
              category, image_url, price, attributes, created_at, updated_at
       FROM catalog_items
       WHERE tenant_id = ? AND catalog_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .bind(tenantId, catalogId, limit)
    .all<CatalogItemRow>();

  return (result.results ?? []).map(toItem);
};

export const ingestCatalogItem = async (
  c: AppContext,
  tenantId: string,
  catalog: Catalog,
  item: CatalogItemInput
) => {
  const now = Date.now();
  const embeddingClient = getEmbeddingClient(c);
  const { text, imageUrl } = buildCatalogEmbeddingInput(catalog, item);

  const embedding = await generateMultimodalEmbedding(
    text,
    imageUrl,
    embeddingClient,
    'RETRIEVAL_DOCUMENT'
  );

  if (embedding.every((value) => value === 0)) {
    throw new Error('Failed to generate an item embedding');
  }

  await persistCatalogItemWithOutbox(
    c.env.DB,
    tenantId,
    catalog.id,
    item,
    embedding,
    now
  );
  await drainCatalogOutbox(c.env, 1);

  return { itemId: item.item_id, indexedAt: now };
};

const actionWeight = (action: CatalogInteractionInput['action']): number => {
  const weights: Record<CatalogInteractionInput['action'], number> = {
    view: 0.25,
    click: 1,
    like: 2,
    dislike: -2,
    save: 1.5,
    dismiss: -1,
    purchase: 3,
    complete: 3,
  };
  return weights[action];
};

export const recordCatalogInteraction = async (
  c: AppContext,
  tenantId: string,
  catalogId: string,
  input: CatalogInteractionInput
) => {
  const item = await getCatalogItem(
    c.env.DB,
    tenantId,
    catalogId,
    input.item_id
  );
  if (!item) {
    throw new Error('ITEM_NOT_FOUND');
  }

  const publicInteractionId = input.id ?? crypto.randomUUID();
  const interaction = {
    ...input,
    id: `${tenantId}:${catalogId}:${publicInteractionId}`,
  };
  const now = Date.now();
  const weight = actionWeight(interaction.action);
  await persistCatalogInteractionWithOutbox(
    c.env.DB,
    tenantId,
    catalogId,
    interaction,
    weight,
    now
  );

  await c.env.CACHE.delete(
    `recs:${tenantId}:${catalogId}:${interaction.user_id}`
  );
  await drainCatalogOutbox(c.env, 1);

  return { interactionId: publicInteractionId, weight };
};

const lexicalSearch = async (
  db: D1Database,
  tenantId: string,
  catalogId: string,
  query: string,
  limit: number
) => {
  const pattern = `%${query.toLowerCase()}%`;
  const result = await db
    .prepare(
      `SELECT tenant_id, catalog_id, item_id, title, description, tags,
              category, image_url, price, attributes, created_at, updated_at,
              CASE
                WHEN lower(title) = lower(?) THEN 1.0
                WHEN lower(title) LIKE ? THEN 0.9
                WHEN lower(tags) LIKE ? THEN 0.75
                WHEN lower(category) LIKE ? THEN 0.65
                WHEN lower(coalesce(description, '')) LIKE ? THEN 0.55
                ELSE 0.4
              END AS lexical_score
       FROM catalog_items
       WHERE tenant_id = ? AND catalog_id = ?
         AND (
           lower(title) LIKE ?
           OR lower(tags) LIKE ?
           OR lower(category) LIKE ?
           OR lower(coalesce(description, '')) LIKE ?
           OR lower(attributes) LIKE ?
         )
       ORDER BY lexical_score DESC, updated_at DESC
       LIMIT ?`
    )
    .bind(
      query,
      pattern,
      pattern,
      pattern,
      pattern,
      tenantId,
      catalogId,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      limit
    )
    .all<CatalogItemRow & { lexical_score: number }>();

  return (result.results ?? []).map((row) => ({
    item: toItem(row),
    score: row.lexical_score,
  }));
};

export const searchCatalog = async (
  c: AppContext,
  tenantId: string,
  catalogId: string,
  query: string,
  limit: number
) => {
  const [lexical, queryVector] = await Promise.all([
    lexicalSearch(c.env.DB, tenantId, catalogId, query, limit),
    generateEmbedding(query, getEmbeddingClient(c), 'RETRIEVAL_QUERY'),
  ]);

  const semantic = queryVector.every((value) => value === 0)
    ? []
    : await getCatalogVectorIndex(c, tenantId, catalogId).query({
        vector: queryVector,
        topK: Math.min(limit * 2, 100),
        includeMetadata: true,
      });

  const merged = new Map<
    string,
    {
      item_id: string;
      title: string;
      description?: string;
      tags: string[];
      category?: string;
      image_url?: string;
      price?: number;
      attributes: Record<string, unknown>;
      semantic_score: number;
      lexical_score: number;
      score: number;
      sources: string[];
    }
  >();

  for (const result of semantic) {
    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    merged.set(String(result.id), {
      item_id: String(result.id),
      title: String(metadata.title ?? ''),
      description: String(metadata.description ?? '') || undefined,
      tags: Array.isArray(metadata.tags)
        ? metadata.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      category: String(metadata.category ?? '') || undefined,
      image_url: String(metadata.image_url ?? '') || undefined,
      price:
        typeof metadata.price === 'number' ? metadata.price : undefined,
      attributes:
        metadata.attributes &&
        typeof metadata.attributes === 'object' &&
        !Array.isArray(metadata.attributes)
          ? (metadata.attributes as Record<string, unknown>)
          : {},
      semantic_score: result.score,
      lexical_score: 0,
      score: result.score * 0.75,
      sources: ['semantic'],
    });
  }

  for (const result of lexical) {
    const existing = merged.get(result.item.item_id);
    const semanticScore = existing?.semantic_score ?? 0;
    merged.set(result.item.item_id, {
      item_id: result.item.item_id,
      title: result.item.title,
      description: result.item.description,
      tags: result.item.tags,
      category: result.item.category,
      image_url: result.item.image_url,
      price: result.item.price,
      attributes: result.item.attributes,
      semantic_score: semanticScore,
      lexical_score: result.score,
      score: semanticScore * 0.75 + result.score * 0.25,
      sources: existing ? ['semantic', 'lexical'] : ['lexical'],
    });
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

const getUserInteractions = async (
  db: D1Database,
  tenantId: string,
  catalogId: string,
  userId: string
) => {
  const result = await db
    .prepare(
      `SELECT item_id, action, weight, timestamp
       FROM catalog_interactions
       WHERE tenant_id = ? AND catalog_id = ? AND user_id = ?
       ORDER BY timestamp DESC
       LIMIT 200`
    )
    .bind(tenantId, catalogId, userId)
    .all<InteractionRow>();

  return result.results ?? [];
};

const buildUserVector = async (
  c: AppContext,
  tenantId: string,
  catalogId: string,
  interactions: InteractionRow[]
) => {
  const itemIds = [...new Set(interactions.map((entry) => entry.item_id))];
  if (itemIds.length === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  const vectors = await getCatalogVectorIndex(c, tenantId, catalogId).fetch(
    itemIds,
    { includeVectors: true }
  );
  const byId = new Map(
    vectors
      .filter((entry) => entry?.vector)
      .map((entry) => [String(entry!.id), entry!.vector as number[]])
  );
  const aggregate = new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  let absoluteWeight = 0;
  const now = Date.now();

  for (const interaction of interactions) {
    const vector = byId.get(interaction.item_id);
    if (!vector) continue;
    const ageDays = Math.max(0, now - interaction.timestamp) / 86_400_000;
    const decayedWeight = interaction.weight * Math.exp(-0.08 * ageDays);
    absoluteWeight += Math.abs(decayedWeight);
    for (let index = 0; index < vector.length; index += 1) {
      aggregate[index] += vector[index] * decayedWeight;
    }
  }

  if (absoluteWeight === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  const norm = Math.sqrt(
    aggregate.reduce((total, value) => total + value * value, 0)
  );
  return norm === 0
    ? new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0)
    : aggregate.map((value) => value / norm);
};

const popularCatalogItems = async (
  db: D1Database,
  tenantId: string,
  catalogId: string,
  limit: number
) => {
  const result = await db
    .prepare(
      `SELECT i.tenant_id, i.catalog_id, i.item_id, i.title, i.description,
              i.tags, i.category, i.image_url, i.price, i.attributes,
              i.created_at, i.updated_at,
              coalesce(sum(x.weight), 0) AS popularity
       FROM catalog_items i
       LEFT JOIN catalog_interactions x
         ON x.tenant_id = i.tenant_id
        AND x.catalog_id = i.catalog_id
        AND x.item_id = i.item_id
       WHERE i.tenant_id = ? AND i.catalog_id = ?
       GROUP BY i.tenant_id, i.catalog_id, i.item_id
       ORDER BY popularity DESC, i.updated_at DESC
       LIMIT ?`
    )
    .bind(tenantId, catalogId, limit)
    .all<CatalogItemRow & { popularity: number }>();

  return (result.results ?? []).map((row) => ({
    ...toItem(row),
    score: row.popularity,
  }));
};

export const recommendCatalogItems = async (
  c: AppContext,
  tenantId: string,
  catalogId: string,
  userId: string,
  limit: number
) => {
  const cacheKey = `recs:${tenantId}:${catalogId}:${userId}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached) as Record<string, unknown>;

  const interactions = await getUserInteractions(
    c.env.DB,
    tenantId,
    catalogId,
    userId
  );
  const userVector = await buildUserVector(
    c,
    tenantId,
    catalogId,
    interactions
  );
  const hasSignal = userVector.some((value) => value !== 0);
  const seen = new Set(interactions.map((entry) => entry.item_id));

  let recommendations: Array<Record<string, unknown>>;
  let strategy: 'personalized' | 'popular';

  if (hasSignal) {
    const results = await getCatalogVectorIndex(c, tenantId, catalogId).query({
      vector: userVector,
      topK: Math.min(Math.max(limit * 4, 20), 100),
      includeMetadata: true,
    });
    recommendations = results
      .filter((result) => !seen.has(String(result.id)))
      .slice(0, limit)
      .map((result) => ({
        item_id: String(result.id),
        score: result.score,
        ...((result.metadata ?? {}) as Record<string, unknown>),
      }));
    strategy = 'personalized';
  } else {
    const popular = await popularCatalogItems(
      c.env.DB,
      tenantId,
      catalogId,
      limit
    );
    recommendations = popular.map((item) => ({
      item_id: item.item_id,
      title: item.title,
      description: item.description,
      tags: item.tags,
      category: item.category,
      image_url: item.image_url,
      price: item.price,
      attributes: item.attributes,
      score: item.score,
    }));
    strategy = 'popular';
  }

  const response = {
    recommendations,
    metadata: {
      tenant_id: tenantId,
      catalog_id: catalogId,
      user_id: userId,
      strategy,
      learned_from_interactions: interactions.length,
      cache_hit: false,
    },
  };

  await c.env.CACHE.put(cacheKey, JSON.stringify(response), {
    expirationTtl: CONFIG.CACHE_TTL.RECOMMENDATIONS,
  });

  return response;
};
