import type { Context } from 'hono';
import type { AppVariables, EnvBindings } from '../types';
import {
  interactionInputSchema,
  parseCatalogItem,
  recommendationInputSchema,
  searchInputSchema,
} from '../validation/recommendation-schemas';
import {
  getCatalogItem,
  ingestCatalogItem,
  listCatalogItems,
  recommendCatalogItems,
  recordCatalogInteraction,
  searchCatalog,
} from '../services/catalog-recommendations';
import { handleError } from '../utils';

type AppContext = Context<{
  Bindings: EnvBindings;
  Variables: AppVariables;
}>;

const scope = (c: AppContext) => {
  const tenantId = c.get('tenantId');
  const catalog = c.get('catalog');
  if (!tenantId || !catalog) return null;
  return { tenantId, catalog };
};

export const ingestCatalogItemRoute = async (c: AppContext) => {
  const resolved = scope(c);
  if (!resolved) return c.json({ error: 'Catalog not found' }, 404);

  try {
    const item = parseCatalogItem(await c.req.json(), resolved.catalog);
    const result = await ingestCatalogItem(
      c,
      resolved.tenantId,
      resolved.catalog,
      item
    );

    return c.json(
      {
        success: true,
        item_id: result.itemId,
        catalog_id: resolved.catalog.id,
        indexed_at: result.indexedAt,
      },
      201
    );
  } catch (error: unknown) {
    return handleError(c, error, 'Failed to ingest item');
  }
};

export const listCatalogItemsRoute = async (c: AppContext) => {
  const resolved = scope(c);
  if (!resolved) return c.json({ error: 'Catalog not found' }, 404);

  const limit = Math.min(
    Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1),
    100
  );
  const items = await listCatalogItems(
    c.env.DB,
    resolved.tenantId,
    resolved.catalog.id,
    limit
  );
  return c.json({ items });
};

export const getCatalogItemRoute = async (c: AppContext) => {
  const resolved = scope(c);
  if (!resolved) return c.json({ error: 'Catalog not found' }, 404);

  const item = await getCatalogItem(
    c.env.DB,
    resolved.tenantId,
    resolved.catalog.id,
    c.req.param('itemId') ?? ''
  );
  return item
    ? c.json({ item })
    : c.json({ error: 'Item not found' }, 404);
};

export const logCatalogInteractionRoute = async (c: AppContext) => {
  const resolved = scope(c);
  if (!resolved) return c.json({ error: 'Catalog not found' }, 404);

  try {
    const input = interactionInputSchema.parse(await c.req.json());
    const result = await recordCatalogInteraction(
      c,
      resolved.tenantId,
      resolved.catalog.id,
      input
    );
    return c.json(
      {
        success: true,
        interaction_id: result.interactionId,
        applied_weight: result.weight,
      },
      201
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'ITEM_NOT_FOUND') {
      return c.json({ error: 'Item not found' }, 404);
    }
    return handleError(c, error, 'Failed to record interaction');
  }
};

export const searchCatalogRoute = async (c: AppContext) => {
  const resolved = scope(c);
  if (!resolved) return c.json({ error: 'Catalog not found' }, 404);

  try {
    const input = searchInputSchema.parse(c.req.query());
    const results = await searchCatalog(
      c,
      resolved.tenantId,
      resolved.catalog.id,
      input.query,
      input.limit
    );

    return c.json({
      results,
      metadata: {
        strategy: 'hybrid',
        lexical_weight: 0.25,
        semantic_weight: 0.75,
        consistency: 'read-after-write via lexical fallback',
      },
    });
  } catch (error: unknown) {
    return handleError(c, error, 'Failed to search catalog', 400);
  }
};

export const recommendCatalogItemsRoute = async (c: AppContext) => {
  const resolved = scope(c);
  if (!resolved) return c.json({ error: 'Catalog not found' }, 404);

  try {
    const { limit } = recommendationInputSchema.parse(c.req.query());
    const userId = c.req.param('userId');
    if (!userId) return c.json({ error: 'User ID is required' }, 400);
    const response = await recommendCatalogItems(
      c,
      resolved.tenantId,
      resolved.catalog.id,
      userId,
      limit
    );
    return c.json(response);
  } catch (error: unknown) {
    return handleError(c, error, 'Failed to recommend catalog items');
  }
};
