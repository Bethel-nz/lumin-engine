# Tenancy and Catalog Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller register a catalog describing their own item shape, scoped to a tenant resolved from their API key.

**Architecture:** Two D1 tables — `tenants` and `catalogs`. An API key already resolves to a Better Auth user via `requireApiKey`; that user id becomes the tenant id. A `resolveTenant` middleware puts `tenantId` on the Hono context, and a `requireCatalog` middleware loads a catalog by id and rejects one belonging to another tenant with 404, never 403. Catalog field definitions and embed config are stored as JSON columns and validated with zod on write.

**Tech Stack:** Hono, D1 (raw prepared statements, matching `services/database.ts`), drizzle schema for Better Auth adapter compatibility, zod, vitest.

## Global Constraints

- No comments in source. Rationale goes in commit messages.
- Raw `db.prepare().bind()` for queries, matching `src/services/database.ts`. Drizzle tables are declared for schema/adapter parity only.
- Timestamps in new tables are `integer` epoch seconds, matching `migrations/0002_add_better_auth_tables.sql`.
- A catalog belonging to another tenant returns 404, not 403 — a 403 confirms the catalog exists.
- Every test builds its D1 mock with `createD1Mock()` from `src/lib/test-utils.ts` and rebuilds it in `beforeEach`, because `vi.resetAllMocks()` strips chainable implementations.
- Migration files are numbered sequentially; the next free number is `0004`.

---

### Task 1: Catalog and tenant schema

**Files:**
- Create: `migrations/0004_add_tenants_and_catalogs.sql`
- Create: `src/db/schema/catalogs.ts`
- Modify: `src/db/schema/index.ts`
- Test: none. No schema file in this repo carries a unit test, and a test over a drizzle declaration restates the declaration. The SQL/drizzle agreement is exercised for real by Task 3, whose storage tests bind against these column names.

**Interfaces:**
- Consumes: nothing.
- Produces: tables `tenants(id, name, created_at, updated_at)` and `catalogs(id, tenant_id, name, fields, embed_config, created_at, updated_at)`; drizzle exports `tenants`, `catalogs`.

- [ ] **Step 1: Write the migration**

Create `migrations/0004_add_tenants_and_catalogs.sql`:

```sql
CREATE TABLE IF NOT EXISTS `tenants` (
    `id` text PRIMARY KEY NOT NULL,
    `name` text NOT NULL,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE TABLE IF NOT EXISTS `catalogs` (
    `id` text PRIMARY KEY NOT NULL,
    `tenant_id` text NOT NULL REFERENCES `tenants`(`id`) ON DELETE CASCADE,
    `name` text NOT NULL,
    `fields` text NOT NULL,
    `embed_config` text NOT NULL,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_catalogs_tenant_id` ON `catalogs`(`tenant_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_catalogs_tenant_name` ON `catalogs`(`tenant_id`, `name`);
```

- [ ] **Step 2: Apply it and verify the tables exist**

Run:

```bash
bunx wrangler d1 migrations apply lumin-db --local
```

Then:

```bash
bunx wrangler d1 execute lumin-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tenants','catalogs')"
```

Expected: both `tenants` and `catalogs` listed.

- [ ] **Step 3: Write the drizzle schema**

Create `src/db/schema/catalogs.ts`:

```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const catalogs = sqliteTable('catalogs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fields: text('fields').notNull(),
  embedConfig: text('embed_config').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 4: Export it**

In `src/db/schema/index.ts`, add as the first line:

```ts
export * from './catalogs';
```

- [ ] **Step 5: Verify types compile**

Run: `bunx tsc --noEmit 2>&1 | grep -E '^src/' | grep -v '\.test\.ts' | wc -l`
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add migrations/0004_add_tenants_and_catalogs.sql src/db/schema/catalogs.ts src/db/schema/index.ts
git commit -m "feat(db): add tenants and catalogs tables"
```

---

### Task 2: Catalog validation schemas

**Files:**
- Create: `src/validation/catalog-schemas.ts`
- Test: `src/validation/catalog-schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `catalogFieldSchema`, `embedConfigSchema`, `createCatalogSchema`, and types `CatalogField`, `EmbedConfig`, `CreateCatalog`.

- [ ] **Step 1: Write the failing test**

Create `src/validation/catalog-schemas.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test src/validation/catalog-schemas.test.ts`
Expected: FAIL — cannot resolve `./catalog-schemas`.

- [ ] **Step 3: Write the schemas**

Create `src/validation/catalog-schemas.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test src/validation/catalog-schemas.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/validation/catalog-schemas.ts src/validation/catalog-schemas.test.ts
git commit -m "feat(validation): add catalog registration schemas"
```

---

### Task 3: Catalog storage service

**Files:**
- Create: `src/services/catalogs.ts`
- Test: `src/services/catalogs.test.ts`

**Interfaces:**
- Consumes: `CreateCatalog`, `CatalogField`, `EmbedConfig` from Task 2.
- Produces:
  - `type Catalog = { id: string; tenantId: string; name: string; fields: CatalogField[]; embedConfig: EmbedConfig }`
  - `ensureTenant(db: D1Database, tenantId: string, name: string): Promise<void>`
  - `createCatalog(db: D1Database, tenantId: string, input: CreateCatalog): Promise<Catalog>`
  - `getCatalog(db: D1Database, tenantId: string, catalogId: string): Promise<Catalog | null>`
  - `listCatalogs(db: D1Database, tenantId: string): Promise<Catalog[]>`

- [ ] **Step 1: Write the failing test**

Create `src/services/catalogs.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test src/services/catalogs.test.ts`
Expected: FAIL — cannot resolve `./catalogs`.

- [ ] **Step 3: Write the service**

Create `src/services/catalogs.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test src/services/catalogs.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/services/catalogs.ts src/services/catalogs.test.ts
git commit -m "feat(catalogs): add tenant-scoped catalog storage"
```

---

### Task 4: Tenant resolution middleware

**Files:**
- Create: `src/middleware/tenant.ts`
- Modify: `src/types/index.ts:144-147`
- Test: `src/middleware/tenant.test.ts`

**Interfaces:**
- Consumes: `getCatalog`, `Catalog` from Task 3; `AppVariables` from `src/types`.
- Produces: `resolveTenant`, `requireCatalog` Hono middlewares; `AppVariables` gains `tenantId: string | null` and `catalog: Catalog | null`.

- [ ] **Step 1: Extend AppVariables**

In `src/types/index.ts`, replace the `AppVariables` interface with:

```ts
export interface AppVariables {
  userId: string | null;
  apiKeyId: string | null;
  tenantId: string | null;
  catalog: import('../services/catalogs').Catalog | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/middleware/tenant.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `bun run test src/middleware/tenant.test.ts`
Expected: FAIL — cannot resolve `./tenant`.

- [ ] **Step 4: Write the middleware**

Create `src/middleware/tenant.ts`:

```ts
import type { Context, Next } from 'hono';
import type { AppVariables, EnvBindings } from '../types';
import { getCatalog } from '../services/catalogs';

type AppContext = Context<{ Bindings: EnvBindings; Variables: AppVariables }>;

export const resolveTenant = async (c: AppContext, next: Next) => {
  const userId = c.get('userId');

  if (!userId) {
    return c.json({ error: 'Unauthorized: no tenant for this key' }, 401);
  }

  c.set('tenantId', userId);
  await next();
};

export const requireCatalog = async (c: AppContext, next: Next) => {
  const tenantId = c.get('tenantId');
  const catalogId = c.req.param('catalogId');

  if (!tenantId || !catalogId) {
    return c.json({ error: 'Catalog not found' }, 404);
  }

  const catalog = await getCatalog(c.env.DB, tenantId, catalogId);

  if (!catalog) {
    return c.json({ error: 'Catalog not found' }, 404);
  }

  c.set('catalog', catalog);
  await next();
};
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `bun run test src/middleware/tenant.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/middleware/tenant.ts src/middleware/tenant.test.ts src/types/index.ts
git commit -m "feat(middleware): resolve tenant from api key and scope catalog lookups"
```

---

### Task 5: Catalog registration routes

**Files:**
- Create: `src/routes/catalogs.ts`
- Modify: `src/index.ts:108-114`
- Test: `src/routes/catalogs.test.ts`

**Interfaces:**
- Consumes: `createCatalogSchema` (Task 2), `createCatalog`/`listCatalogs`/`ensureTenant` (Task 3), `resolveTenant`/`requireCatalog` (Task 4).
- Produces: `createCatalogRoute`, `listCatalogsRoute`, `getCatalogRoute`; routes `POST /api/catalogs`, `GET /api/catalogs`, `GET /api/catalogs/:catalogId`.

- [ ] **Step 1: Write the failing test**

Create `src/routes/catalogs.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test src/routes/catalogs.test.ts`
Expected: FAIL — cannot resolve `./catalogs`.

- [ ] **Step 3: Write the routes**

Create `src/routes/catalogs.ts`:

```ts
import type { Context } from 'hono';
import type { AppVariables, EnvBindings } from '../types';
import { handleError } from '../utils';
import { createCatalogSchema } from '../validation/catalog-schemas';
import {
  createCatalog,
  ensureTenant,
  listCatalogs,
} from '../services/catalogs';

type AppContext = Context<{ Bindings: EnvBindings; Variables: AppVariables }>;

export const createCatalogRoute = async (c: AppContext) => {
  try {
    const tenantId = c.get('tenantId') as string;
    const input = createCatalogSchema.parse(await c.req.json());

    await ensureTenant(c.env.DB, tenantId, tenantId);
    const catalog = await createCatalog(c.env.DB, tenantId, input);

    return c.json(
      {
        catalog_id: catalog.id,
        name: catalog.name,
        fields: catalog.fields,
        embed_config: catalog.embedConfig,
      },
      201
    );
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to create catalog');
  }
};

export const listCatalogsRoute = async (c: AppContext) => {
  try {
    const tenantId = c.get('tenantId') as string;
    const found = await listCatalogs(c.env.DB, tenantId);

    return c.json({
      catalogs: found.map((catalog) => ({
        catalog_id: catalog.id,
        name: catalog.name,
        fields: catalog.fields,
        embed_config: catalog.embedConfig,
      })),
    });
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to list catalogs');
  }
};

export const getCatalogRoute = async (c: AppContext) => {
  const catalog = c.get('catalog');

  if (!catalog) {
    return c.json({ error: 'Catalog not found' }, 404);
  }

  return c.json({
    catalog_id: catalog.id,
    name: catalog.name,
    fields: catalog.fields,
    embed_config: catalog.embedConfig,
  });
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test src/routes/catalogs.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Register the routes**

In `src/index.ts`, add these imports next to the existing route imports:

```ts
import {
  createCatalogRoute,
  getCatalogRoute,
  listCatalogsRoute,
} from './routes/catalogs';
import { requireCatalog, resolveTenant } from './middleware/tenant';
```

Then add below the existing protected routes:

```ts
app.post('/api/catalogs', requireApiKey, resolveTenant, createCatalogRoute);
app.get('/api/catalogs', requireApiKey, resolveTenant, listCatalogsRoute);
app.get(
  '/api/catalogs/:catalogId',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  getCatalogRoute
);
```

- [ ] **Step 6: Verify the whole suite and types**

Run: `bun run test`
Expected: all files pass.

Run: `bunx tsc --noEmit 2>&1 | grep -E '^src/' | grep -v '\.test\.ts' | wc -l`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
git add src/routes/catalogs.ts src/routes/catalogs.test.ts src/index.ts
git commit -m "feat(routes): add catalog registration endpoints"
```

---

### Task 6: End-to-end verification against the local stack

**Files:**
- Modify: none — this task verifies the running service.

**Interfaces:**
- Consumes: everything above.
- Produces: a confirmed working registration flow, and confidence that tenant isolation holds against a real D1.

- [ ] **Step 1: Start the worker**

Run:

```bash
bunx wrangler dev --port 8787
```

Wait for `Ready on http://localhost:8787`.

- [ ] **Step 2: Register a catalog**

Using an API key created through the normal local sign-up and API-key flow:

```bash
curl -s -X POST http://localhost:8787/api/catalogs -H "Content-Type: application/json" -H "X-Api-Key: $LUMIN_KEY" -d '{"name":"products","fields":[{"name":"brand","type":"string"}],"embed_config":{"text_fields":["title","description","brand"],"image_field":"image_url"}}'
```

Expected: HTTP 201 with a `catalog_id`.

- [ ] **Step 3: Confirm it lists back**

```bash
curl -s http://localhost:8787/api/catalogs -H "X-Api-Key: $LUMIN_KEY"
```

Expected: one catalog, matching the one just created.

- [ ] **Step 4: Confirm an unknown catalog is 404, not 403**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/catalogs/does-not-exist -H "X-Api-Key: $LUMIN_KEY"
```

Expected: `404`.

- [ ] **Step 5: Confirm the rows landed**

```bash
bunx wrangler d1 execute lumin-db --local --command "SELECT id, tenant_id, name FROM catalogs"
```

Expected: the catalog row, with `tenant_id` equal to the seeded admin user id.

- [ ] **Step 6: Commit any fixes**

If steps 2-5 revealed defects, fix them, re-run `bun run test`, and commit with a message describing the defect and its cause.

---

## Self-Review

**Spec coverage.** This plan covers the spec's tenancy decision (multi-tenant, many catalogs each), runtime catalog registration, the per-catalog embed config that replaces the hardcoded embedding text, and the 404-not-403 rule. It deliberately does **not** cover: `items__v1`/`interactions__v1`, the pipe surface, Upstash namespacing, or the KV-to-Redis swap. Those are the next plans and depend on this one.

**Placeholders.** None — every step carries the code or command it needs.

**Type consistency.** `Catalog` is defined in Task 3 and consumed by Tasks 4 and 5 with the same property names (`tenantId`, `embedConfig`). `CreateCatalog` from Task 2 is the input type in Task 3 and Task 5. `AppVariables` gains `tenantId` and `catalog` in Task 4 before the routes in Task 5 read them.

**Known gap, deliberate:** `ensureTenant` uses the tenant id as the tenant name. There is no tenant-naming flow yet because nothing needs one; the column exists so a later plan can fill it without a migration.
