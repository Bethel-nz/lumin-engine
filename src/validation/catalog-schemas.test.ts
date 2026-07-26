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

  it('rejects a text_fields entry that does not match the identifier regex', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        embed_config: {
          text_fields: ["x'); DROP TABLE catalogs;--"],
          image_field: 'image_url',
        },
      })
    ).toThrow();
  });

  it('rejects an image_field that does not match the identifier regex', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        embed_config: {
          text_fields: ['title'],
          image_field: '$(rm -rf /)',
        },
      })
    ).toThrow();
  });

  it('rejects a text_fields entry naming a field that is neither core nor declared', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        fields: [{ name: 'brand', type: 'string' }],
        embed_config: {
          text_fields: ['nonexistent'],
          image_field: 'image_url',
        },
      })
    ).toThrow();
  });

  it('accepts text_fields referencing a declared custom field', () => {
    const parsed = createCatalogSchema.parse({
      ...valid,
      fields: [{ name: 'brand', type: 'string' }],
      embed_config: {
        text_fields: ['brand'],
        image_field: 'image_url',
      },
    });
    expect(parsed.embed_config.text_fields).toContain('brand');
  });

  it('accepts text_fields referencing only core fields', () => {
    const parsed = createCatalogSchema.parse({
      ...valid,
      fields: [],
      embed_config: {
        text_fields: ['title', 'description'],
        image_field: 'image_url',
      },
    });
    expect(parsed.embed_config.text_fields).toEqual(['title', 'description']);
  });

  it('rejects a field named tenant_id', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        fields: [{ name: 'tenant_id', type: 'string' }],
        embed_config: { text_fields: ['title'] },
      })
    ).toThrow();
  });

  it('rejects a field named attributes', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        fields: [{ name: 'attributes', type: 'string' }],
        embed_config: { text_fields: ['title'] },
      })
    ).toThrow();
  });

  it('rejects an image_field naming a field that is neither core nor declared', () => {
    expect(() =>
      createCatalogSchema.parse({
        ...valid,
        fields: [{ name: 'brand', type: 'string' }],
        embed_config: {
          text_fields: ['title'],
          image_field: 'photo',
        },
      })
    ).toThrow();
  });
});
