# Lumin Engine

> **[experimental]** A real-time, hybrid recommendation engine for personalized event discovery at the edge.

Lumin is a production-grade recommendation service built to power deeply personalized discovery experiences. It combines semantic understanding, collaborative filtering, behavioral analytics, and contextual signals to deliver relevant, diverse, and serendipitous recommendations in real-time.

Unlike traditional recommendation systems, Lumin operates entirely at the edge, uses a multi-database architecture for optimal performance, and continuously adapts to user behavior through exploration strategies and A/B testing.

## Origin Story

Lumin was originally built as the recommendation backend for [Synaxis](https://github.com/vyr-e/synaxis), a community events discovery platform. During development, I realized the recommendation engine had evolved into something that could be useful beyond just events—it could recommend articles, products, music, or any content with descriptive metadata.

Rather than keeping it tightly coupled to the main platform (which, admittedly, I got a bit lazy building out), I decided to extract it into a standalone, item-agnostic service that others could use and learn from. The "experimental" tag reflects its origin as a learning project and the ongoing refinement of its hybrid algorithms—but it's battle-tested with real event data and production-ready architecture.

Think of it as an open-source alternative to traditional recommendation systems, built for developers who want full control over their discovery experience without vendor lock-in.

## Current State

The engine is mid-migration from event-specific to domain-agnostic. What exists
today:

- **Done** — Gemini Embedding 2 multimodal embeddings (text + image), and the
  tenancy layer: an API key resolves to a tenant, and tenants register catalogs
  describing their own item shape via `/api/catalogs`.
- **Next** — the generic `items__v1` model with a JSON attributes bag, per-tenant
  Upstash vector namespacing, and a generic pipe surface. Ingestion, search and
  recommendations still speak `event` until that lands.

See [docs/superpowers/specs](docs/superpowers/specs) for the design and
[docs/superpowers/plans](docs/superpowers/plans) for the implementation plans.

> **Known gap:** `/ingest-event`, `/log-interactions`, `/search` and
> `/get-recommendations/:userId` authenticate but are **not** tenant-scoped yet —
> there is one un-namespaced vector index and no tenant column on events. Do not
> issue a second API key against real data until the item model lands.

## Core Concepts

### The Hybrid Recommendation Approach

Lumin builds a multi-dimensional understanding of each user by combining:

1. **Content-Based Filtering (50%)** - Semantic similarity using vector embeddings of event descriptions, titles, and tags
2. **Tag Preferences (30%)** - Explicit user preferences captured through tag selection
3. **Collaborative Filtering (20%)** - Learning from similar users' interactions and preferences  
4. **Demographic Context (10%)** - Incorporating location, interests, and user attributes

These signals are weighted and merged into a single "taste vector" that powers real-time similarity search.

### Exploration vs. Exploitation

The engine balances **exploitation** (showing known good recommendations) with **exploration** (discovering new interests):

- **Adaptive Exploration Rate**: Starts at 40% for new users, decreases to 15% as they interact more
- **Multi-Strategy Exploration**: Injects trending items, serendipitous picks, and anti-correlated recommendations
- **Engagement Tracking**: Doubles exploration rate if user engagement drops below 30%

### Real-Time Adaptation

Every interaction updates the system immediately:
- Recommendations are invalidated and recomputed
- User taste vectors decay over time (exponential decay)
- Recent interactions carry more weight than historical ones
- Background jobs pre-compute aggregate signals every 30 minutes

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Edge Runtime** | Cloudflare Workers |
| **Web Framework** | Hono |
| **Vector Database** | Upstash Vector (1536-dim embeddings) |
| **Relational Database** | Cloudflare D1 (SQLite) + Drizzle ORM |
| **Analytics Engine** | Tinybird (real-time data pipes) |
| **Cache Layer** | Cloudflare KV |
| **Embeddings Model** | Gemini Embedding 2 (multimodal, 1536-dim) |
| **Auth** | Better Auth + API key plugin |
| **Validation** | Zod |
| **Testing** | Vitest |

## Architecture Overview

```
┌─────────────────┐
│  User Request   │
└────────┬────────┘
         │
         v
┌──────────────────────────────────────────┐
│  Cloudflare Workers (Hono Router)        │
│  • Rate Limiting                         │
│  • CORS + Auth                           │
│  • Cache Check (KV)                      │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Hybrid Vector Computation               │
│  • Fetch user interactions (D1)          │
│  • Load interaction vectors (Upstash)    │
│  • Generate tag embeddings (Gemini)      │
│  • Apply collaborative filtering (D1)    │
│  • Blend with demographics (Gemini)      │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Vector Similarity Search (Upstash)      │
│  • Query top 200 candidates              │
│  • Apply tag filtering (if applicable)   │
│  • A/B test: diversification strategy    │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Exploration Injection                   │
│  • Trending events (Tinybird)            │
│  • Serendipity items (uncommon tags)     │
│  • Anti-correlated picks (inverse vec)   │
└──────────┬───────────────────────────────┘
           │
           v
┌──────────────────────────────────────────┐
│  Cache Result → Return to User           │
└──────────────────────────────────────────┘
```

### Data Persistence Strategy

**Upstash Vector** → Semantic search and vector operations  
**Cloudflare D1** → Relational data, user profiles, interaction history  
**Tinybird** → Real-time analytics, trending events, behavioral patterns  
**Cloudflare KV** → Distributed caching, user preferences, A/B test groups

## Getting Started

### Prerequisites

- **Node.js 18+** or **Bun**
- **Cloudflare Workers** account
- **Upstash Vector** database
- **Tinybird** workspace
- **Google AI** API key (Gemini)

### Environment Setup

Create a `.dev.vars` file for local development:

```env
# Vector Database
VECTOR_URL=your_upstash_vector_url
VECTOR_TOKEN=your_upstash_vector_token

# AI Embeddings
GEMINI_API_KEY=your_google_ai_api_key

# Analytics
TINYBIRD_TOKEN=your_tinybird_token
# Tinybird Local runs on http://localhost:7181; use https://api.tinybird.co for cloud
TINYBIRD_BASE_URL=http://localhost:7181

# Authentication
BETTER_AUTH_SECRET=generate_with_openssl_rand_base64_32
BETTER_AUTH_URL=http://localhost:8787

# Optional: Monitoring
MONITORING_ENDPOINT=https://...
MONITORING_TOKEN=...
METRICS_ENDPOINT=https://...
METRICS_TOKEN=...
ALERTS_WEBHOOK=https://...
```

`wrangler.jsonc` is gitignored. Copy `wrangler.jsonc.template` and fill in:
- D1 database binding (`DB`)
- KV namespace bindings (`CACHE`, `TAG_VECTORS_KV`)
- `account_id` and any production vars

### Development

```bash
bun install
bun run dev
bun run test
bun run deploy
```

### Local Setup

The whole stack runs locally — no cloud resources required except Upstash Vector
and a Gemini key.

```bash
# 1. Start Tinybird Local
docker compose up -d

# 2. Generate datafiles from the TypeScript schemas, then build against Local
bun run tb:generate
cd tinybird && tb build
```

`tb build` targets whatever `dev_mode` in `tinybird/tinybird.config.json` says
(`local`). It creates a workspace branch named after your git branch, so take
the token from `tb token ls` — the base workspace token will authenticate but
see no datasources.

```bash
# 3. Apply D1 migrations locally
bunx wrangler d1 migrations apply lumin-db --local

# 4. Start the worker
bunx wrangler dev --port 8787

# 5. Mint the first API key (one time)
curl -s -X POST http://localhost:8787/api/admin/seed
```

The seed response contains an `apiKey` shown only once. Send it as `X-Api-Key`
on every protected route.

For production, create the D1 database with `bunx wrangler d1 create lumin-db`,
apply migrations with `--remote`, and deploy Tinybird with `bun run tb:deploy`.

## Core API Endpoints

Every route below requires an API key from `POST /api/admin/seed`, sent as
`X-Api-Key` (or `X-App-Key`, or `Authorization: Bearer …`).

### POST `/api/catalogs`

Register a catalog describing the shape of your items. The API key resolves to a
tenant, and a catalog belongs to that tenant.

The **embed config** is the important part: it declares which fields concatenate
into the text sent to Gemini, and which field holds the image URL. That replaces
any hardcoded, domain-specific embedding string, and is what lets one deployment
serve events, products, articles, or anything else.

**Request Body:**
```json
{
  "name": "products",
  "fields": [
    { "name": "brand", "type": "string" },
    { "name": "in_stock", "type": "boolean" }
  ],
  "embed_config": {
    "text_fields": ["title", "description", "brand"],
    "image_field": "image_url"
  }
}
```

Field names must be lowercase identifiers, must not collide with a core item
column (`item_id`, `title`, `description`, `tags`, `category`, `image_url`,
`price`, `tenant_id`, `catalog_id`, `attributes`, …), and every name referenced
by `embed_config` must be either a core column or one of your declared fields.

**Response:** `201` with `catalog_id`, `name`, `fields`, `embed_config`.
Reusing a name you already registered returns `409`.

### GET `/api/catalogs`

List your catalogs. Scoped to your tenant.

### GET `/api/catalogs/:catalogId`

Fetch one catalog. A catalog belonging to another tenant returns `404`, never
`403` — a `403` would confirm it exists.

### GET `/get-recommendations/:userId`

Get personalized event recommendations for a user.

**Rate Limit:** 50 requests per 15 minutes per user  
**Cache TTL:** 30 minutes

**Response:**
```json
{
  "recommendations": [
    {
      "event_id": "event_123",
      "score": 0.89,
      "diversified": false
    }
  ],
  "metadata": {
    "user_id": "user_456",
    "ab_group": "A",
    "exploration_rate": 0.25,
    "total_candidates": 42,
    "cache_hit": false
  }
}
```

### POST `/log-interactions`

Log user interactions to update taste profiles in real-time.

**Rate Limit:** 100 requests per 15 minutes globally

**Request Body:**
```json
{
  "id": "interaction_01JXYZ",
  "user_id": "user_456",
  "event_id": "event_123",
  "action": "view" | "click" | "like" | "dislike" | "select_tags" | "signup",
  "session_id": "session_123",
  "source": "web",
  "tags": ["optional", "for", "select_tags"]
}
```

`id` is supplied by the caller and is the idempotency key for the interaction.
The same ID is reused in D1 and Tinybird, so safely retrying a request does not
teach the recommendation model twice.

**Action Weights:**
- `select_tags`: 5.0 (highest signal)
- `like`: 2.0
- `click`: 1.0
- `view`: 0.5
- `dislike`: -1.0 (negative signal)
- `signup`: 0.0 (tracked but neutral)

**Response:**
```json
{
  "success": true,
  "interaction_id": "interaction_01JXYZ",
  "message": "Interaction logged for user user_456"
}
```

### POST `/ingest-event`

Submit a new event to the recommendation system.

**Rate Limit:** 100 requests per 15 minutes globally

**Request Body:**
```json
{
  "id": "event_789",
  "title": "Summer Music Festival 2025",
  "description": "A three-day outdoor music festival featuring indie and electronic artists.",
  "tags": ["music", "festival", "outdoor"],
  "host": "City Events Co",
  "category": "entertainment",
  "location": "San Francisco, CA",
  "event_date": 1752602400000,
  "metadata": {
    "url": "https://example.com/events/789",
    "image_url": "https://example.com/images/789.jpg",
    "price": "50-120"
  }
}
```

**Process:**
1. Validates event schema with Zod
2. Generates a multimodal embedding (Gemini Embedding 2) - text fields, plus the image at `image_url` when present
3. Starts Tinybird ingestion while the embedding is generated
4. Stores the same caller-supplied ID in Upstash Vector and D1
5. Queues failed Tinybird, vector, or D1 operations for idempotent retry

**Response:**
```json
{
  "success": true,
  "event_id": "event_789",
  "message": "Event \"Summer Music Festival 2025\" ingested.",
  "tinybird_response": {}
}
```

### GET `/search?query=<text>`

Perform semantic search over all events.

**Rate Limit:** 100 requests per 15 minutes globally

**Query Parameters:**
- `query` (required): Natural language search query
- `limit` (optional): Number of results (default: 20, max: 50)

**Response:**
```json
{
  "results": [
    {
      "id": "event_123",
      "title": "Tech Meetup: AI and Ethics",
      "tags": ["technology", "ai", "ethics"],
      "score": 0.91
    }
  ],
  "query": "artificial intelligence discussions"
}
```

## Recommendation Algorithm Details

### Hybrid Vector Formula

```
User Vector = 0.5 × Interaction Vector
            + 0.3 × Tag Preference Vector
            + 0.2 × Collaborative Vector
            + 0.1 × Demographics Vector
```

### Time Decay Function

Recent interactions are weighted more heavily:

```
Weight(t) = base_weight × e^(-0.1 × days_ago)
```

### Exploration Rate Calculation

```
exploration_rate = max(0.15, 0.4 - interaction_count × 0.01)

if engagement_rate < 0.3:
    exploration_rate *= 2
```

### A/B Test Groups

**Group A** (50% of users):
- Initial top-K: 40 candidates
- Diversification: ON (80/20 split between top and tail candidates)

**Group B** (50% of users):
- Initial top-K: 50 candidates
- Diversification: OFF (pure ranking)

### Exploration Injection Slots

Trending, serendipitous, or anti-correlated items are injected at positions **[2, 5, 8]** in the recommendation list.

## Scheduled Background Jobs

### Tag Vector Updates (Every 30 minutes)

```typescript
// Recomputes aggregate vectors for active tags
// Uses exponential moving average (learning rate: 0.1)
scheduledTagVectorUpdate()
```

### Recommendation Pre-computation (Every 1 hour)

```typescript
// Pre-computes and caches recommendations for active users
// Reduces latency on first request
scheduledRecommendationUpdate()
```

## Security & Rate Limiting

- **API Key Authentication**: Custom `X-App-Key` header required
- **CORS**: Enabled for `localhost:3000` and `https://synaxis-app.vercel.app`
- **Rate Limiting**: Sliding window algorithm with KV-based counters
- **Input Validation**: Zod schemas for all endpoints
- **Edge Security**: Runs on Cloudflare's secure edge network

## Monitoring & Observability

- **Structured Logging**: JSON logs with request context
- **Metrics Tracking**: Success/error rates, latency, cache hit rates
- **Compensation Queue**: Event sourcing for reliable distributed writes
- **Retry Strategy**: Exponential backoff with jitter (max 3 retries)

## Data Sources (Tinybird)

### Ingestion Tables
- `events__v1`: Event metadata and descriptions
- `interactions__v1`: User interaction logs with timestamps

### Analytics Pipes
- `trending_events__v1`: Top events by engagement (24h window)
- `event_similarity__v1`: Similar events based on metadata
- `user_behavior__v1`: User preference patterns and trends
- `realtime_trending__v1`: Real-time trending events
- `location_trends__v1`: Geographic trending patterns

## Development Scripts

```bash
# Tinybird
bun run tb:generate    # Generate .datasource/.pipe files from the TS schemas
bun run tb:push        # Deploy generated datafiles
bun run tb:deploy      # generate + push

# Auth
bun run auth:generate  # Regenerate Better Auth schema
bun run auth:migrate   # Apply Better Auth migrations

# Testing
bun run test           # Run all tests
bun run test:watch     # Watch mode
bun run coverage       # Coverage report

# Deployment
bun run dev            # Local worker
bun run deploy         # Deploy to Cloudflare Workers
bun run cf-typegen     # Regenerate binding types
```

D1 migrations are applied with wrangler directly:

```bash
bunx wrangler d1 migrations apply lumin-db --local
```

## Project Structure

```
src/
├── routes/                    # API endpoint handlers
│   ├── recommendations.ts
│   ├── interactions.ts
│   ├── events.ts
│   ├── search.ts
│   └── catalogs.ts            # Catalog registration
├── services/                  # Core business logic
│   ├── recommendations.ts     # Hybrid vector computation
│   ├── exploration.ts         # Exploration strategies
│   ├── embedding.ts           # Gemini Embedding 2 client
│   ├── vector.ts              # Embedding generation, Upstash reads
│   ├── eventService.ts        # Ingestion orchestration
│   ├── event-storage.ts       # D1 and vector persistence
│   ├── catalogs.ts            # Tenant-scoped catalog storage
│   ├── compensation.ts        # Retry queue for partial failures
│   ├── observability.ts       # Logging, metrics, timing
│   └── scheduled.ts           # Cron handlers
├── db/schema/                 # Drizzle schemas (D1)
│   ├── catalogs.ts            # tenants, catalogs
│   ├── auth.ts                # Better Auth tables
│   ├── events.ts
│   ├── interactions.ts
│   └── user-profiles.ts
├── lib/
│   ├── clients.ts             # Upstash Vector client
│   ├── auth.ts                # Better Auth setup
│   ├── tinybird.ts            # Ingestion endpoints
│   └── tinybird-pipes.ts      # Pipe definitions
├── middleware/
│   ├── auth.ts                # requireApiKey
│   └── tenant.ts              # resolveTenant, requireCatalog
├── validation/                # Zod schemas
│   ├── catalog-schemas.ts
│   └── tinybird-schemas.ts    # TinyKit datasource definitions
├── config/index.ts            # Weights, limits, A/B test config
├── utils/index.ts             # Error handling, retry
└── index.ts                   # Worker entry point

migrations/                    # D1 migrations
tinybird/                      # Generated datafiles + tb config
docs/superpowers/              # Design specs and implementation plans
```

## Performance Characteristics

- **Cold Start**: < 100ms (edge Workers)
- **Cache Hit**: < 50ms (KV lookup)
- **Cache Miss**: 200-800ms (vector search + computation)
- **Ingestion**: < 1s (parallel writes with compensation)
- **Vector Dimensions**: 1536 (Gemini Embedding 2, truncated from 3072 via MRL; returned unit-normalized)
- **Recommendation List Size**: 20 items (configurable)

## Roadmap

- [x] Multi-modal embeddings (text + images)
- [ ] Graph-based collaborative filtering
- [ ] Contextual bandits for exploration
- [ ] Real-time feedback loops
- [ ] Multi-region vector replication
- [ ] Item-to-item recommendations
- [ ] Explanation generation for recommendations

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Architecture Diagram

View the full interactive architecture diagram:  
[Excalidraw - Lumin Architecture](https://excalidraw.com/#json=T0FgGo0V8KY4nhcWL2IHG,TX5w1r5KBh0glXcOy84EHw)
