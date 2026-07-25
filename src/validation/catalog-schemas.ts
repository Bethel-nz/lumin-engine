import { z } from 'zod';

export const CORE_ITEM_FIELDS = [
  'item_id',
  'title',
  'description',
  'tags',
  'category',
  'image_url',
  'price',
  'created_at',
  'updated_at',
] as const;

export const catalogFieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/)
    .refine(
      (name) => !(CORE_ITEM_FIELDS as readonly string[]).includes(name),
      { message: 'field name collides with a core item column' }
    ),
  type: z.enum(['string', 'number', 'boolean', 'string[]']),
});

export const embedConfigSchema = z.object({
  text_fields: z.array(z.string().min(1)).min(1),
  image_field: z.string().min(1).optional(),
});

export const createCatalogSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/),
  fields: z
    .array(catalogFieldSchema)
    .default([])
    .refine(
      (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
      { message: 'duplicate field names' }
    ),
  embed_config: embedConfigSchema,
});

export type CatalogField = z.infer<typeof catalogFieldSchema>;
export type EmbedConfig = z.infer<typeof embedConfigSchema>;
export type CreateCatalog = z.infer<typeof createCatalogSchema>;
