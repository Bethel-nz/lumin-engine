import type { Context, Next } from 'hono';
import type { AppVariables, EnvBindings } from '../types';
import { getCatalog } from '../services/catalogs';

type AppContext = Context<{ Bindings: EnvBindings; Variables: AppVariables }>;

export const resolveTenant = async (c: AppContext, next: Next) => {
  const userId = c.get('userId');

  if (!userId) {
    return c.json({ error: 'Unauthorized: no tenant for this key' }, 401);
  }

  c.set('tenantId', userId);
  await next();
};

export const requireCatalog = async (c: AppContext, next: Next) => {
  const tenantId = c.get('tenantId');
  const catalogId = c.req.param('catalogId');

  if (!tenantId || !catalogId) {
    return c.json({ error: 'Catalog not found' }, 404);
  }

  const catalog = await getCatalog(c.env.DB, tenantId, catalogId);

  if (!catalog) {
    return c.json({ error: 'Catalog not found' }, 404);
  }

  c.set('catalog', catalog);
  await next();
};
