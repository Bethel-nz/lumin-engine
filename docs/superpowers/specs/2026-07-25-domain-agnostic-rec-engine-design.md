# Domain-agnostic recommendation engine

Date: 2026-07-25
Status: implemented locally

## Problem

Lumin is an event recommendation engine. `event` is baked into the Tinybird
datasources, the D1 schema, every pipe, the vector metadata, and the route
names. Anyone wanting recommendations over products, articles, videos or
listings has to pretend their data is an event: `host` means brand, `event_date`
means release date, `capacity` means nothing at all.

The goal is an engine where a caller brings their own data, describes its shape
once, and gets recommendations - without a code change or a deploy on our side.

## Decisions

Four decisions were settled before this design:

1. **Pluggable schema per catalog.** Callers register their own field
   definitions rather than mapping onto a fixed generic schema.
2. **Runtime registration.** A catalog is created through the API and is usable
   immediately. No `tinykit generate` + `tb deploy` cycle per customer.
3. **Multi-tenant, many catalogs per tenant.** A tenant owns N catalogs. An API
   key resolves to a tenant and can only reach that tenant's catalogs.
4. **Generic pipes plus facet trends.** `location_trends` generalizes to trend
   by any declared attribute rather than being dropped or kept as-is.

## Why one datasource and not one per catalog

Tinybird datasources are statically typed and created by deploy. Runtime
registration therefore cannot mean "a typed datasource per catalog" without
putting a deploy in the signup path.

So there is exactly one `items__v1`, carrying a **universal core** as real typed
columns plus an `attributes` JSON string for everything catalog-specific.

The core is deliberately small - the fields nearly every catalog has, and the
fields the hot paths touch:

```
tenant_id, catalog_id, item_id, title, description, tags,
category, image_url, price, created_at, updated_at, attributes
```

Everything else - `event_date`, `location`, `capacity`, `host`, `brand`,
`author`, `duration` - lives in `attributes` and is read with `JSONExtract`.

The alternative, putting *everything* in the bag including `title`, was
rejected: `trending_items` and `item_similarity` read `title` on every row, and
paying `JSONExtract` there buys no flexibility, since a recommendable item
without a name is not a thing.

Events stop being special. An event is a catalog whose `attributes` happen to
contain `event_date` and `location`.

## Data model

**`items__v1`** - sorting key `tenant_id, catalog_id, created_at, item_id`.

**`interactions__v1`** - sorting key `tenant_id, catalog_id, timestamp, user_id,
item_id`. `event_id` becomes `item_id` throughout.

`tenant_id` leads both sorting keys. This is why the work is not staged into
"generalize now, multi-tenant later": adding `tenant_id` to a sorting key later
means rebuilding both datasources and rewriting every pipe's WHERE clause a
second time.

**Catalog registry (D1)** - `tenants` and `catalogs`. Each catalog declares its
fields, and critically an **embed config**: which fields concatenate into the
text input, and which field supplies the image URL. This replaces the hardcoded
`${title} ${description} ${tags} hosted by ${host}` in `processEventIngestion`.

Field definitions are stored as a JSON column on `catalogs`, not as a normalized
`catalog_fields` table. It matches how `embed_config` is stored, keeps the
storage layer to one row per catalog, and adding keys later is backward
compatible. The cost is that "which catalogs declare attribute X" needs a scan
rather than an index — revisit if `facet_trends` or attribute promotion makes
that query hot.

**Vectors** - one Upstash index, namespace per `{tenant_id}:{catalog_id}`.
Isolation is structural rather than a metadata filter that can be forgotten at
one call site.

## Pipes

Four generic, all scoped by `tenant_id` + `catalog_id`:

- `trending_items`
- `realtime_trending`
- `user_behavior`
- `item_similarity`

Plus `facet_trends`, which takes an attribute name and trends by its values.
`location_trends` becomes `facet_trends(attribute='location')`.

## Embedding

Already migrated (commit `f465dcc`): Gemini Embedding 2, 1536-d, multimodal,
`RETRIEVAL_DOCUMENT` on ingest and `RETRIEVAL_QUERY` on search.

The remaining change is that the text input is assembled from the catalog's
embed config rather than from fixed event fields, and `image_url` is read from
the field the catalog nominates.

## Migration

Effectively greenfield. The Tinybird workspace is empty and the Upstash index
holds 0 vectors, so `events__v1` and the five event pipes are replaced outright
rather than versioned alongside. There is no backfill and no dual-write window.

### Legacy route removal

The event-specific routes are no longer registered. Their replacements live
under `/api/catalogs/:catalogId/**` and always execute
`requireApiKey -> resolveTenant -> requireCatalog` before reaching a handler.
Vectors use a structural `{tenant_id}:{catalog_id}` namespace, while D1 and
Tinybird carry both identifiers on every item and interaction.

The old source remains temporarily as migration history, but no request or cron
handler can reach it.

## Search

Search is hybrid. A Gemini query embedding drives catalog-namespaced Upstash
semantic retrieval while D1 performs a scoped lexical lookup over the item read
model. Results are fused by item ID with a 75/25 semantic-to-lexical score.

This is also the read-after-write strategy: a newly ingested vector may briefly
be absent from a similarity query, but its D1 row is immediately eligible for
an exact or lexical match. Replace `LIKE` with catalog-scoped FTS only after
measured catalog size warrants it.

## Error handling

The implemented catalog path performs synchronous multi-store writes. Tinybird
ingestion failures currently fail the request, while image fetch failures
degrade to a text-only vector and complete embedding failures stop item
ingestion. D1 and Upstash item upserts run in parallel, so one can succeed while
the other fails. The legacy event path has compensation machinery, but the
generic catalog path does not use it yet.

The production hardening path is a D1 transactional outbox that makes derived
Upstash and Tinybird writes replayable. A request naming an unknown catalog, or
a catalog belonging to another tenant, is a 404 - not a 403, which would
confirm that the catalog exists.

## Testing

The current route tests are event-shaped but structurally sound - they assert
orchestration, compensation and cache invalidation, which all survive the
rename. They get renamed, not rewritten. New coverage needed for: catalog
registration and validation, tenant isolation (a key for tenant A cannot read
tenant B's catalog), attributes round-tripping through `JSONExtract`, and
`facet_trends` over a declared attribute.

## Open question

Per-catalog `attributes` are unindexed. If a customer filters heavily on one
attribute it will scan. The promotion path - materializing a hot attribute into
a real column - is deliberately not designed here; it should wait until a real
workload shows which attributes are hot.
