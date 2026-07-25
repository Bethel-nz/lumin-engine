import type {
  CatalogField,
  CreateCatalog,
  EmbedConfig,
} from '../validation/catalog-schemas';

export interface Catalog {
  id: string;
  tenantId: string;
  name: string;
  fields: CatalogField[];
  embedConfig: EmbedConfig;
}

interface CatalogRow {
  id: string;
  tenant_id: string;
  name: string;
  fields: string;
  embed_config: string;
}

const toCatalog = (row: CatalogRow): Catalog => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  fields: JSON.parse(row.fields) as CatalogField[],
  embedConfig: JSON.parse(row.embed_config) as EmbedConfig,
});

export const ensureTenant = async (
  db: D1Database,
  tenantId: string,
  name: string
): Promise<void> => {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO tenants (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .bind(tenantId, name, now, now)
    .run();
};

export const createCatalog = async (
  db: D1Database,
  tenantId: string,
  input: CreateCatalog
): Promise<Catalog> => {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const fields = JSON.stringify(input.fields);
  const embedConfig = JSON.stringify(input.embed_config);

  await db
    .prepare(
      `INSERT INTO catalogs
       (id, tenant_id, name, fields, embed_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, tenantId, input.name, fields, embedConfig, now, now)
    .run();

  return {
    id,
    tenantId,
    name: input.name,
    fields: input.fields,
    embedConfig: input.embed_config,
  };
};

export const getCatalog = async (
  db: D1Database,
  tenantId: string,
  catalogId: string
): Promise<Catalog | null> => {
  const row = await db
    .prepare(
      `SELECT id, tenant_id, name, fields, embed_config
       FROM catalogs
       WHERE id = ? AND tenant_id = ?`
    )
    .bind(catalogId, tenantId)
    .first<CatalogRow>();

  return row ? toCatalog(row) : null;
};

export const listCatalogs = async (
  db: D1Database,
  tenantId: string
): Promise<Catalog[]> => {
  const result = await db
    .prepare(
      `SELECT id, tenant_id, name, fields, embed_config
       FROM catalogs
       WHERE tenant_id = ?
       ORDER BY created_at DESC`
    )
    .bind(tenantId)
    .all<CatalogRow>();

  return (result.results ?? []).map(toCatalog);
};
