import { z } from 'zod';

export const CORE_ITEM_FIELDS = [
  'tenant_id',
  'catalog_id',
  'item_id',
  'title',
  'description',
  'tags',
  'category',
  'image_url',
  'price',
  'created_at',
  'updated_at',
  'attributes',
  'constructor',
  'prototype',
] as const;

export const EMBEDDABLE_CORE_ITEM_FIELDS = [
  'item_id',
  'title',
  'description',
  'tags',
  'category',
  'image_url',
  'price',
] as const;

const IDENTIFIER_REGEX = /^[a-z][a-z0-9_]*$/;

export const catalogFieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(IDENTIFIER_REGEX)
    .refine(
      (name) => !(CORE_ITEM_FIELDS as readonly string[]).includes(name),
      { message: 'field name collides with a core item column' }
    ),
  type: z.enum(['string', 'number', 'boolean', 'string[]']),
});

export const embedConfigSchema = z.object({
  text_fields: z.array(z.string().min(1).regex(IDENTIFIER_REGEX)).min(1),
  image_field: z.string().min(1).regex(IDENTIFIER_REGEX).optional(),
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
}).refine(
  (data) => {
    const validFields = new Set([
      ...EMBEDDABLE_CORE_ITEM_FIELDS,
      ...data.fields.map((f) => f.name),
    ]);
    const textFieldsValid = data.embed_config.text_fields.every((field) =>
      validFields.has(field)
    );
    const imageFieldValid =
      !data.embed_config.image_field ||
      validFields.has(data.embed_config.image_field);
    return textFieldsValid && imageFieldValid;
  },
  (data) => {
    const validFields = new Set([
      ...EMBEDDABLE_CORE_ITEM_FIELDS,
      ...data.fields.map((f) => f.name),
    ]);
    const invalidTextFields = data.embed_config.text_fields.filter(
      (field) => !validFields.has(field)
    );
    const invalidImageField =
      data.embed_config.image_field &&
      !validFields.has(data.embed_config.image_field)
        ? data.embed_config.image_field
        : null;
    const offendingName = invalidTextFields[0] || invalidImageField;
    return {
      message: `field '${offendingName}' does not exist`,
    };
  }
);

export type CatalogField = z.infer<typeof catalogFieldSchema>;
export type EmbedConfig = z.infer<typeof embedConfigSchema>;
export type CreateCatalog = z.infer<typeof createCatalogSchema>;
