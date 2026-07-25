import { describe, it, expect } from 'vitest';
import { createCatalogSchema } from './catalog-schemas';

const valid = {
  name: 'products',
  fields: [
    { name: 'brand', type: 'string' as const },
    { name: 'release_date', type: 'number' as const },
  ],
  embed_config: {
    text_fields: ['title', 'description', 'brand'],
    image_field: 'image_url',
  },
};

describe('createCatalogSchema', () => {
  it('accepts a catalog with fields and an embed config', () => {
    expect(createCatalogSchema.parse(valid).name).toBe('products');
  });

  it('rejects an embed config with no text fields', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        embed_config: { text_fields: [], image_field: 'image_url' },
      })
    ).toThrow();
  });

  it('allows an embed config with no image field', () => {
    const parsed = createCatalogSchema.parse({
      ...valid,
      embed_config: { text_fields: ['title'] },
    });
    expect(parsed.embed_config.image_field).toBeUndefined();
  });

  it('rejects duplicate field names', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        fields: [
          { name: 'brand', type: 'string' },
          { name: 'brand', type: 'number' },
        ],
      })
    ).toThrow();
  });

  it('rejects a field that collides with a core column', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        fields: [{ name: 'title', type: 'string' }],
      })
    ).toThrow();
  });
});
