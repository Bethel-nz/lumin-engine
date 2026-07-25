import type { Context } from 'hono';
import type { AppVariables, EnvBindings } from '../types';
import { handleError } from '../utils';
import { createCatalogSchema } from '../validation/catalog-schemas';
import {
  createCatalog,
  ensureTenant,
  listCatalogs,
} from '../services/catalogs';

type AppContext = Context<{ Bindings: EnvBindings; Variables: AppVariables }>;

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed');

export const createCatalogRoute = async (c: AppContext) => {
  let catalogName: string | undefined;
  try {
    const tenantId = c.get('tenantId') as string;
    const input = createCatalogSchema.parse(await c.req.json());
    catalogName = input.name;

    await ensureTenant(c.env.DB, tenantId, tenantId);
    const catalog = await createCatalog(c.env.DB, tenantId, input);

    return c.json(
      {
        catalog_id: catalog.id,
        name: catalog.name,
        fields: catalog.fields,
        embed_config: catalog.embedConfig,
      },
      201
    );
  } catch (e: unknown) {
    if (isUniqueConstraintError(e)) {
      return c.json(
        {
          error: `A catalog named '${catalogName}' already exists for this tenant`,
        },
        409
      );
    }
    return handleError(c, e, 'Failed to create catalog');
  }
};

export const listCatalogsRoute = async (c: AppContext) => {
  try {
    const tenantId = c.get('tenantId') as string;
    const found = await listCatalogs(c.env.DB, tenantId);

    return c.json({
      catalogs: found.map((catalog) => ({
        catalog_id: catalog.id,
        name: catalog.name,
        fields: catalog.fields,
        embed_config: catalog.embedConfig,
      })),
    });
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to list catalogs');
  }
};

export const getCatalogRoute = async (c: AppContext) => {
  const catalog = c.get('catalog');

  if (!catalog) {
    return c.json({ error: 'Catalog not found' }, 404);
  }

  return c.json({
    catalog_id: catalog.id,
    name: catalog.name,
    fields: catalog.fields,
    embed_config: catalog.embedConfig,
  });
};
