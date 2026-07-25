import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createD1Mock } from '../lib/test-utils';
import { createCatalog, getCatalog, ensureTenant } from './catalogs';

const input = {
  name: 'products',
  fields: [{ name: 'brand', type: 'string' as const }],
  embed_config: { text_fields: ['title'], image_field: 'image_url' },
};

describe('catalog storage', () => {
  let db: ReturnType<typeof createD1Mock>;

  beforeEach(() => {
    vi.resetAllMocks();
    db = createD1Mock();
  });

  it('stores fields and embed config as JSON', async () => {
    const catalog = await createCatalog(db as any, 'tenant-1', input);

    expect(catalog.tenantId).toBe('tenant-1');
    expect(catalog.name).toBe('products');
    expect(catalog.fields).toEqual(input.fields);

    const bound = db.statement.bind.mock.calls.at(-1) ?? [];
    expect(bound).toContain(JSON.stringify(input.fields));
    expect(bound).toContain(JSON.stringify(input.embed_config));
  });

  it('scopes the lookup by tenant', async () => {
    db.statement.first.mockResolvedValue({
      id: 'cat-1',
      tenant_id: 'tenant-1',
      name: 'products',
      fields: JSON.stringify(input.fields),
      embed_config: JSON.stringify(input.embed_config),
    });

    const catalog = await getCatalog(db as any, 'tenant-1', 'cat-1');

    expect(catalog?.fields).toEqual(input.fields);
    expect(db.statement.bind).toHaveBeenCalledWith('cat-1', 'tenant-1');
  });

  it('returns null when the catalog belongs to another tenant', async () => {
    db.statement.first.mockResolvedValue(null);
    await expect(getCatalog(db as any, 'tenant-2', 'cat-1')).resolves.toBeNull();
  });

  it('upserts the tenant idempotently', async () => {
    await ensureTenant(db as any, 'tenant-1', 'Acme');
    const sql = db.prepare.mock.calls.at(-1)?.[0] ?? '';
    expect(sql).toContain('ON CONFLICT');
  });
});
