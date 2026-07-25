import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTenant, requireCatalog } from './tenant';
import * as catalogs from '../services/catalogs';
import { createD1Mock } from '../lib/test-utils';

vi.mock('../services/catalogs');

const makeContext = (overrides: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>();
  return {
    req: { param: vi.fn(), header: vi.fn() },
    json: vi.fn(),
    env: { DB: createD1Mock() },
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
    ...overrides,
  } as any;
};

describe('resolveTenant', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses the api key user id as the tenant id', async () => {
    const c = makeContext();
    c.set('userId', 'user-1');
    const next = vi.fn();

    await resolveTenant(c, next);

    expect(c.get('tenantId')).toBe('user-1');
    expect(next).toHaveBeenCalled();
  });

  it('rejects when no api key user was resolved', async () => {
    const c = makeContext();
    c.set('userId', null);
    const next = vi.fn();

    await resolveTenant(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(c.json).toHaveBeenCalledWith(
      { error: 'Unauthorized: no tenant for this key' },
      401
    );
  });
});

describe('requireCatalog', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads the catalog for the tenant', async () => {
    const catalog = {
      id: 'cat-1',
      tenantId: 'user-1',
      name: 'products',
      fields: [],
      embedConfig: { text_fields: ['title'] },
    };
    vi.mocked(catalogs.getCatalog).mockResolvedValue(catalog);

    const c = makeContext();
    c.set('tenantId', 'user-1');
    c.req.param.mockReturnValue('cat-1');
    const next = vi.fn();

    await requireCatalog(c, next);

    expect(c.get('catalog')).toEqual(catalog);
    expect(next).toHaveBeenCalled();
  });

  it('returns 404 for another tenant catalog, never 403', async () => {
    vi.mocked(catalogs.getCatalog).mockResolvedValue(null);

    const c = makeContext();
    c.set('tenantId', 'user-2');
    c.req.param.mockReturnValue('cat-1');
    const next = vi.fn();

    await requireCatalog(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(c.json).toHaveBeenCalledWith({ error: 'Catalog not found' }, 404);
  });
});
