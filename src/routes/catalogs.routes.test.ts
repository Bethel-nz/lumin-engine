import { describe, it, expect } from 'vitest';
import { app } from '../index';
import { requireApiKey } from '../middleware/auth';
import { requireCatalog, resolveTenant } from '../middleware/tenant';
import {
  createCatalogRoute,
  getCatalogRoute,
  listCatalogsRoute,
} from './catalogs';

const handlersFor = (path: string, method: string) =>
  app.routes
    .filter((r) => r.path === path && r.method === method)
    .map((r) => r.handler);

describe('catalog route wiring', () => {
  it('mounts requireApiKey then resolveTenant then createCatalogRoute on POST /api/catalogs', () => {
    expect(handlersFor('/api/catalogs', 'POST')).toEqual([
      requireApiKey,
      resolveTenant,
      createCatalogRoute,
    ]);
  });

  it('mounts requireApiKey then resolveTenant then listCatalogsRoute on GET /api/catalogs', () => {
    expect(handlersFor('/api/catalogs', 'GET')).toEqual([
      requireApiKey,
      resolveTenant,
      listCatalogsRoute,
    ]);
  });

  it('mounts requireApiKey then resolveTenant then requireCatalog then getCatalogRoute on GET /api/catalogs/:catalogId', () => {
    expect(handlersFor('/api/catalogs/:catalogId', 'GET')).toEqual([
      requireApiKey,
      resolveTenant,
      requireCatalog,
      getCatalogRoute,
    ]);
  });
});
