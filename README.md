# Lumin Engine

Lumin is a tenant-isolated recommendation service that turns interaction history
into a current model of a user's taste.

The interesting problem is not finding items similar to one query. It is
deciding which behavior should remain useful, which signals should fade, and how
that learned preference should transfer to items the user has never seen. Lumin
keeps that process explicit: interactions are weighted evidence, time decay
changes their influence, and the resulting taste vector is derived state that
can be rebuilt.

A tenant registers a catalog, describes its domain-specific fields, and chooses
which fields shape an item's representation. The same deployment can then serve
movies, books, products, articles, listings, or events without a schema
deployment.

## What it does

- Registers multiple catalogs per tenant.
- Accepts arbitrary catalog fields through a validated `attributes` object.
- Generates 1536-dimensional text or image-aware embeddings with Gemini
  Embedding 2.
- Isolates every catalog in its own Upstash Vector namespace.
- Records weighted positive and negative user interactions.
- Recomputes a time-decayed taste vector after each interaction.
- Serves cold-start popularity results and personalized vector results through
  the same endpoint.
- Provides hybrid search by fusing semantic Upstash results with an immediate
  D1 lexical lookup.
- Streams catalog-scoped item and interaction data into Tinybird for real-time
  analytics.

## Architecture

For the complete system design, request sequences, consistency model, failure
boundaries, and scaling path, read
[`service-architecture.md`](./service-architecture.md).

```text
API key
  └── tenant
      └── catalog
          ├── D1
          │   ├── catalog registry
          │   ├── item read model
          │   └── item delivery outbox
          ├── Upstash Vector namespace: tenant_id:catalog_id
          ├── Tinybird
          │   ├── items__v1
          │   ├── interactions__v1
          │   └── catalog-scoped analytics pipes
          ├── D1 outbox for replaying derived Vector and Tinybird writes
          └── Cloudflare KV recommendation cache
```

The tenant and catalog are resolved before an item, interaction, search, or
recommendation handler runs. A catalog owned by another tenant returns `404`,
so the API does not reveal that it exists.

## Search consistency

Upstash provides semantic retrieval, but a newly written vector can briefly be
absent from a similarity query. Lumin does not pretend that retrying blindly is
a consistency model.

Search therefore runs two catalog-scoped paths concurrently:

1. Gemini query embedding → Upstash semantic search.
2. Immediate D1 lexical search over title, description, tags, category, and
   attributes.

The results are merged by item ID and ranked with a `75% semantic / 25% lexical`
score. The lexical path gives newly ingested and exact-match items immediate
visibility; the semantic path handles intent and conceptual similarity. D1
`LIKE` is deliberately the first implementation. A catalog-scoped FTS index is
the next step when measured catalog size makes it worthwhile.

## Recommendation loop

Interaction weights are intentionally domain-neutral:

| Action | Weight |
| --- | ---: |
| `complete` | 3.0 |
| `purchase` | 3.0 |
| `like` | 2.0 |
| `save` | 1.5 |
| `click` | 1.0 |
| `view` | 0.25 |
| `dismiss` | -1.0 |
| `dislike` | -2.0 |

Lumin fetches the vectors for a user's interacted items, applies each action
weight and exponential time decay, then normalizes the result into the user's
current taste vector. Items the user already interacted with are removed from
the candidate set.

With no usable signal, the endpoint returns catalog popularity ordered by
weighted interactions. Once the user interacts, the same endpoint switches to
the personalized strategy and reports how many interactions informed it.

## Stack

| Layer | Technology |
| --- | --- |
| Runtime | Cloudflare Workers |
| HTTP | Hono |
| Authentication | Better Auth API keys |
| Relational state | Cloudflare D1 + Drizzle |
| Vector retrieval | Upstash Vector |
| Analytics | Tinybird + TinyKit |
| Cache | Cloudflare KV |
| Embeddings | Gemini Embedding 2 |
| Validation | Zod |

## Local setup

Requirements:

- Bun
- Docker
- Tinybird CLI
- Gemini API key
- Upstash Vector index

Create `.dev.vars`:

```env
TINYBIRD_BASE_URL=http://localhost:7181
TINYBIRD_TOKEN=<token printed by `tb info` after build>
GEMINI_API_KEY=<google ai key>
VECTOR_URL=<upstash vector REST URL>
VECTOR_TOKEN=<upstash vector REST token>
BETTER_AUTH_SECRET=<random 32-byte secret>
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000,https://your-app.example
```

Start and build Tinybird Local:

```bash
docker compose up -d
bun install
bun run tb:generate
cd tinybird
tb build
tb info
cd ..
```

The local build can use a temporary Tinybird workspace. Use the `token:` value
reported by `tb info`; a token from `/tokens` may belong to a different
workspace and return `404` for a datasource that was built successfully.

Apply D1 migrations and start the Worker:

```bash
bunx wrangler d1 migrations apply lumin-db --local
bunx wrangler dev --port 8787
```

## Movie demo

The included seed creates one movie catalog and twelve fictional films:

```bash
bun run seed:movies
```

The command creates a fresh local account and API key through the normal auth
endpoints, prints the catalog ID, and ingests the movies through the real HTTP
API. There is no administrative seed endpoint in the Worker.

Use the returned API key as `X-Lumin-Key`. `X-App-Key`, `X-Api-Key`, and a
Bearer token in `Authorization` remain supported for compatibility.

```bash
curl \
  -H "X-Lumin-Key: $LUMIN_API_KEY" \
  "http://localhost:8787/api/catalogs/$CATALOG_ID/items"
```

Log a preference:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Lumin-Key: $LUMIN_API_KEY" \
  "http://localhost:8787/api/catalogs/$CATALOG_ID/interactions" \
  -d '{
    "user_id": "demo-user",
    "item_id": "signal-beyond",
    "action": "like",
    "session_id": "demo-session"
  }'
```

Fetch the learned recommendations:

```bash
curl \
  -H "X-Lumin-Key: $LUMIN_API_KEY" \
  "http://localhost:8787/api/catalogs/$CATALOG_ID/users/demo-user/recommendations"
```

## Live recommendation evaluation

Run the recommendation loop against a fixed 32-item catalog through the real
HTTP API:

```bash
bun run evaluate:recommendations
```

If Wrangler is running on a different port:

```bash
LUMIN_BASE_URL=http://127.0.0.1:8790 bun run evaluate:recommendations
```

The evaluator creates isolated science-fiction, romance, horror, family, and
cold-start users. It reports Precision@5, cross-profile overlap, ranking
stability, seen-item leakage, and whether replaying one interaction ID changes
the number of signals learned by the recommendation profile.

The ground-truth cluster label is stored for scoring but excluded from the
embedding fields. Existing evaluation items are reused by default. Pass
`--reseed` to regenerate their embeddings:

```bash
bun run evaluate:recommendations --reseed
```

## API

All `/api/catalogs/**` routes require an API key.

### Register a catalog

`POST /api/catalogs`

```json
{
  "name": "books",
  "fields": [
    { "name": "author", "type": "string" },
    { "name": "year", "type": "number" },
    { "name": "themes", "type": "string[]" }
  ],
  "embed_config": {
    "text_fields": [
      "title",
      "description",
      "tags",
      "author",
      "themes"
    ],
    "image_field": "image_url"
  }
}
```

Supported custom field types are `string`, `number`, `boolean`, and `string[]`.
Every attribute supplied during ingestion must be declared by the catalog.

### Ingest or update an item

`POST /api/catalogs/:catalogId/items`

```json
{
  "item_id": "book-42",
  "title": "A Map of Small Decisions",
  "description": "A reflective novel about cities, memory, and friendship.",
  "tags": ["literary", "city", "friendship"],
  "category": "fiction",
  "image_url": "https://example.com/cover.jpg",
  "price": 14.99,
  "attributes": {
    "author": "M. Nwosu",
    "year": 2025,
    "themes": ["memory", "belonging"]
  }
}
```

The caller's `item_id` is the idempotency key across D1, Upstash, and Tinybird.

### List and fetch items

- `GET /api/catalogs/:catalogId/items?limit=50`
- `GET /api/catalogs/:catalogId/items/:itemId`

### Record an interaction

`POST /api/catalogs/:catalogId/interactions`

```json
{
  "id": "optional-caller-idempotency-key",
  "user_id": "user-7",
  "item_id": "book-42",
  "action": "complete",
  "session_id": "session-9",
  "source": "web",
  "duration_ms": 420000
}
```

If `id` is omitted, Lumin generates one. Reusing an ID is safe because
Tinybird reads deduplicate the append-only event stream by that stable ID.

### Hybrid search

`GET /api/catalogs/:catalogId/search?query=quiet+space+mystery&limit=20`

Each result includes its combined score, semantic and lexical component scores,
and the sources that produced it.

### Recommendations

`GET /api/catalogs/:catalogId/users/:userId/recommendations?limit=20`

The response metadata reports `popular` or `personalized`,
`learned_from_interactions`, and cache state.

### Analytics

`GET /api/catalogs/:catalogId/analytics?hours=168&bucket_hours=24&top_items_limit=5`

Returns dashboard-ready, catalog-scoped activity from Tinybird: totals by
action, a timestamped series with active users per bucket, and the most engaged
items in the selected period. `hours` defaults to seven days and
`bucket_hours` defaults to one day. Interaction IDs are deduplicated before
they are counted, so Queue retries do not inflate the dashboard.

## Account and API-key lifecycle

Lumin uses Better Auth's email/password flow:

- `POST /api/auth/sign-up/email` to create an account and session.
- `POST /api/auth/sign-in/email` to start a session.
- `POST /api/auth/api-key/create`, `GET /api/auth/api-key/list`,
  `POST /api/auth/api-key/update`, and `POST /api/auth/api-key/delete` to
  manage the signed-in account's API keys.
- `POST /api/auth/delete-user` with the current password to delete the signed-in
  account. This revokes its API keys and removes the account-owned catalog
  records from D1.

The full API key is returned only when it is created. Store it once, then send
it as `X-Lumin-Key` on catalog API requests.

### From account to first authenticated request

The account session is a browser cookie. The API key belongs to that account
and becomes its tenant boundary, so a key can only see the catalogs its owner
created. This is the smallest useful flow for a browser client or an API
console:

```bash
export LUMIN_URL=http://localhost:8787

# Creates the account and saves its session cookie locally.
curl -sS -c lumin.cookies \
  -X POST "$LUMIN_URL/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ada",
    "email": "ada@example.com",
    "password": "choose-a-real-password"
  }'

# The key value is returned in this response once. Keep it outside source code.
curl -sS -b lumin.cookies \
  -X POST "$LUMIN_URL/api/auth/api-key/create" \
  -H "Content-Type: application/json" \
  -d '{ "name": "local development" }'
```

Use the returned `key` as `LUMIN_API_KEY`, then create a catalog with the
first-class Lumin header:

```bash
curl -sS -X POST "$LUMIN_URL/api/catalogs" \
  -H "Content-Type: application/json" \
  -H "X-Lumin-Key: $LUMIN_API_KEY" \
  -d '{
    "name": "books",
    "fields": [
      { "name": "author", "type": "string" },
      { "name": "genre", "type": "string" }
    ],
    "embed_config": {
      "text_fields": ["title", "description", "author", "genre"]
    }
  }'
```

Manage keys from the signed-in session, never with another API key:

```text
GET  /api/auth/api-key/list
POST /api/auth/api-key/update  { "keyId": "...", "name": "production" }
POST /api/auth/api-key/delete  { "keyId": "..." }
POST /api/auth/delete-user     { "password": "..." }
```

Use the `keyId` returned by `list` for updates and revocation. Account deletion
also invalidates all of that account's keys and removes its D1 catalog records.
`X-App-Key`, `X-Api-Key`, and `Authorization: Bearer <key>` remain supported
for existing integrations; new integrations should use `X-Lumin-Key`.

## Tinybird resources

TinyKit generates:

- `items__v1`
- `interactions__v1`
- `trending_items__v1`
- `realtime_trending__v1`
- `user_behavior__v1`
- `user_interactions__v1`
- `item_similarity__v1`
- `facet_trends__v1`
- `catalog_analytics__v1`

Every datasource sorting key and every pipe predicate begins with
`tenant_id, catalog_id`.

## Development commands

```bash
bun run tb:generate
cd tinybird && tb build
cp wrangler.jsonc.template wrangler.jsonc # first-time local setup
bunx wrangler queues create lumin-interactions # once per Cloudflare account
bunx wrangler d1 migrations apply lumin-db --local
bun run dev
bun run seed:movies
bun run evaluate:recommendations
```

`tb build` targets local development. Production Tinybird deployment and
Cloudflare deployment remain separate explicit operations.

## Current boundaries

- Lexical search uses scoped D1 `LIKE`; add FTS only after catalog-size
  measurements justify it.
- Tinybird owns the append-only interaction history. A recommendation cache
  miss asks `user_interactions__v1` for the user's latest deduplicated signals,
  then rebuilds their taste vector from the associated Upstash item vectors.
  The popularity fallback uses `trending_items__v1` and hydrates current item
  details from D1.
- Interaction delivery is Queue → Tinybird, not D1. The stable interaction ID
  makes at-least-once Queue delivery safe. D1's outbox remains for item writes,
  where a single request must coordinate D1, Vector, and Tinybird.
- Existing `catalog_interactions` rows are legacy data. Backfill and verify
  them in Tinybird before dropping that old D1 table from a deployed database.
- The previous event-specific routes are not registered. Their source remains
  temporarily for migration history and can be deleted after downstream callers
  have moved to the catalog API.

## License

MIT
