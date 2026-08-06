import { z } from 'zod';
import type { Catalog } from '../services/catalogs';

export const itemInputSchema = z
  .object({
    item_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    category: z.string().optional(),
    image_url: z.string().url().optional(),
    price: z.number().finite().optional(),
    attributes: z.record(z.unknown()).default({}),
  })
  .strict();

export const interactionActionSchema = z.enum([
  'view',
  'click',
  'like',
  'dislike',
  'save',
  'dismiss',
  'purchase',
  'complete',
]);

export const interactionInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    user_id: z.string().min(1),
    item_id: z.string().min(1),
    action: interactionActionSchema,
    session_id: z.string().min(1),
    source: z.string().min(1).default('web'),
    duration_ms: z.number().int().nonnegative().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const searchInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const recommendationInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const analyticsInputSchema = z.object({
  hours: z.coerce.number().int().positive().max(8_760).default(168),
  bucket_hours: z.coerce.number().int().positive().max(168).default(24),
  top_items_limit: z.coerce.number().int().min(1).max(20).default(5),
});

const validateAttributeValue = (
  value: unknown,
  type: Catalog['fields'][number]['type']
): boolean => {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
};

export const parseCatalogItem = (input: unknown, catalog: Catalog) => {
  const item = itemInputSchema.parse(input);
  const declaredFields = new Map(
    catalog.fields.map((field) => [field.name, field.type])
  );

  for (const [name, value] of Object.entries(item.attributes)) {
    const type = declaredFields.get(name);
    if (!type) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['attributes', name],
          message: `field '${name}' is not declared by this catalog`,
        },
      ]);
    }
    if (!validateAttributeValue(value, type)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['attributes', name],
          message: `field '${name}' must be ${type}`,
        },
      ]);
    }
  }

  return item;
};

export type CatalogItemInput = z.infer<typeof itemInputSchema>;
export type CatalogInteractionInput = z.infer<typeof interactionInputSchema>;
