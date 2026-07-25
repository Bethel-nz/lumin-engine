import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCatalogRoute, listCatalogsRoute } from './catalogs';
import * as catalogs from '../services/catalogs';
import * as utils from '../utils';
import { createD1Mock } from '../lib/test-utils';

vi.mock('../services/catalogs');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return { ...actual, handleError: vi.fn() };
});

const makeContext = () => {
  const store = new Map<string, unknown>([['tenantId', 'tenant-1']]);
  return {
    req: { json: vi.fn(), param: vi.fn() },
    json: vi.fn(),
    env: { DB: createD1Mock() },
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
  } as any;
};

const body = {
  name: 'products',
  fields: [{ name: 'brand', type: 'string' }],
  embed_config: { text_fields: ['title'], image_field: 'image_url' },
};

describe('createCatalogRoute', () => {
  beforeEach(() => vi.resetAllMocks());

  it('creates a catalog for the resolved tenant', async () => {
    const c = makeContext();
    c.req.json.mockResolvedValue(body);
    vi.mocked(catalogs.ensureTenant).mockResolvedValue();
    vi.mocked(catalogs.createCatalog).mockResolvedValue({
      id: 'cat-1',
      tenantId: 'tenant-1',
      name: 'products',
      fields: body.fields as any,
      embedConfig: body.embed_config,
    });

    await createCatalogRoute(c);

    expect(catalogs.createCatalog).toHaveBeenCalledWith(
      c.env.DB,
      'tenant-1',
      expect.objectContaining({ name: 'products' })
    );
    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ catalog_id: 'cat-1', name: 'products' }),
      201
    );
  });

  it('rejects an invalid embed config before touching the database', async () => {
    const c = makeContext();
    c.req.json.mockResolvedValue({ ...body, embed_config: { text_fields: [] } });

    await createCatalogRoute(c);

    expect(catalogs.createCatalog).not.toHaveBeenCalled();
    expect(utils.handleError).toHaveBeenCalledWith(
      c,
      expect.any(Error),
      'Failed to create catalog'
    );
  });

  it('returns 409 when the catalog name is already used by the tenant', async () => {
    const c = makeContext();
    c.req.json.mockResolvedValue(body);
    vi.mocked(catalogs.ensureTenant).mockResolvedValue();
    vi.mocked(catalogs.createCatalog).mockRejectedValue(
      new Error(
        'D1_ERROR: UNIQUE constraint failed: catalogs.tenant_id, catalogs.name'
      )
    );

    await createCatalogRoute(c);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('products'),
      }),
      409
    );
    expect(utils.handleError).not.toHaveBeenCalled();
  });
});

describe('listCatalogsRoute', () => {
  beforeEach(() => vi.resetAllMocks());

  it('lists only the tenant catalogs', async () => {
    const c = makeContext();
    vi.mocked(catalogs.listCatalogs).mockResolvedValue([]);

    await listCatalogsRoute(c);

    expect(catalogs.listCatalogs).toHaveBeenCalledWith(c.env.DB, 'tenant-1');
    expect(c.json).toHaveBeenCalledWith({ catalogs: [] });
  });
});
