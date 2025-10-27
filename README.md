# Lumin Engine

> **[experimental]** A real-time, hybrid recommendation engine for personalized event discovery at the edge.

Lumin is a production-grade recommendation service built to power deeply personalized discovery experiences. It combines semantic understanding, collaborative filtering, behavioral analytics, and contextual signals to deliver relevant, diverse, and serendipitous recommendations in real-time.

Unlike traditional recommendation systems, Lumin operates entirely at the edge, uses a multi-database architecture for optimal performance, and continuously adapts to user behavior through exploration strategies and A/B testing.

## Origin Story

Lumin was originally built as the recommendation backend for [Synaxis](https://github.com/vyr-e/synaxis), a community events discovery platform. During development, I realized the recommendation engine had evolved into something that could be useful beyond just events—it could recommend articles, products, music, or any content with descriptive metadata.

Rather than keeping it tightly coupled to the main platform (which, admittedly, I got a bit lazy building out), I decided to extract it into a standalone, item-agnostic service that others could use and learn from. The "experimental" tag reflects its origin as a learning project and the ongoing refinement of its hybrid algorithms—but it's battle-tested with real event data and production-ready architecture.

Think of it as an open-source alternative to traditional recommendation systems, built for developers who want full control over their discovery experience without vendor lock-in.

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
| **Embeddings Model** | OpenAI text-embedding-3-small |
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
│  • Generate tag embeddings (OpenAI)      │
│  • Apply collaborative filtering (D1)    │
│  • Blend with demographics (OpenAI)      │
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
- **OpenAI** API key

### Environment Setup

Create a `.dev.vars` file for local development:

```env
# Vector Database
VECTOR_URL=your_upstash_vector_url
VECTOR_TOKEN=your_upstash_vector_token

# AI Embeddings
OPENAI_API_KEY=sk-...

# Analytics
TINYBIRD_TOKEN=your_tinybird_token
TINYBIRD_BASE_URL=https://api.tinybird.co

# Authentication
X_APP_KEY=your-secure-application-key

# Optional: Monitoring
MONITORING_ENDPOINT=https://...
MONITORING_TOKEN=...
METRICS_ENDPOINT=https://...
METRICS_TOKEN=...
ALERTS_WEBHOOK=https://...
```

Configure `wrangler.toml` with:
- D1 database binding (`DB`)
- KV namespace bindings (`CACHE`, `TAG_VECTORS_KV`)
- Environment variables (production secrets)

### Development

```bash
# Install dependencies
npm install

# Run local development server (connected to remote resources)
npm run dev

# Run tests
npm run test

# Deploy to production
npm run deploy
```

### Database Setup

```bash
# Create D1 database
npx wrangler d1 create lumin-db

# Run migrations
npx wrangler d1 migrations apply lumin-db --remote

# Initialize Tinybird data sources and pipes
npm run tinybird:push
```

## Core API Endpoints

### GET `/get-recommendations/:userId`

Get personalized event recommendations for a user.

**Rate Limit:** 50 requests per 15 minutes per user  
**Cache TTL:** 30 minutes

**Response:**
```json
{
  "recommendations": [
    {
      "id": "event_123",
      "title": "Tech Meetup: AI and Ethics",
      "tags": ["technology", "ai", "ethics"],
      "host": "Tech Community",
      "score": 0.89,
      "reason": "content" | "trending" | "serendipity"
    }
  ],
  "cached": false,
  "ab_group": "A"
}
```

### POST `/log-interactions`

Log user interactions to update taste profiles in real-time.

**Rate Limit:** 100 requests per 15 minutes globally

**Request Body:**
```json
{
  "user_id": "user_456",
  "event_id": "event_123",
  "action": "view" | "click" | "like" | "dislike" | "select_tags" | "signup",
  "tags": ["optional", "for", "select_tags"]
}
```

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
  "message": "Interaction logged successfully"
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
  "start_date": "2025-07-15T18:00:00Z",
  "metadata": {
    "url": "https://example.com/events/789",
    "image_url": "https://example.com/images/789.jpg",
    "price": "50-120"
  }
}
```

**Process:**
1. Validates event schema with Zod
2. Generates semantic embedding (OpenAI)
3. Parallel writes to:
   - Upstash Vector (with metadata)
   - Tinybird (analytics ingestion)
   - Cloudflare D1 (relational storage)
4. Compensation queue for failed operations

**Response:**
```json
{
  "success": true,
  "event_id": "event_789",
  "vector_id": "vec_xyz"
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
# Database migrations
npm run db:generate    # Generate migration from schema
npm run db:migrate     # Apply migrations to D1
npm run db:studio      # Open Drizzle Studio

# Tinybird
npm run tinybird:push  # Deploy data sources and pipes
npm run tinybird:pull  # Sync from remote workspace

# Testing
npm run test           # Run all tests
npm run test:watch     # Watch mode

# Deployment
npm run deploy         # Deploy to Cloudflare Workers
```

## Project Structure

```
src/
├── routes/           # API endpoint handlers
│   ├── recommendations.ts
│   ├── interactions.ts
│   ├── events.ts
│   └── search.ts
├── services/         # Core business logic
│   ├── recommendations.ts   # Hybrid vector computation
│   ├── exploration.ts       # Exploration strategies
│   ├── vectorization.ts     # OpenAI embeddings
│   └── compensation.ts      # Event sourcing
├── db/               # Database clients and schemas
│   ├── drizzle/      # D1 schema (Drizzle ORM)
│   ├── tinybird/     # Tinybird queries and pipes
│   └── upstash.ts    # Vector database client
├── middleware/       # Hono middleware
│   ├── ratelimit.ts
│   ├── auth.ts
│   └── cors.ts
├── config/           # Configuration constants
│   └── index.ts      # Weights, limits, A/B test config
├── utils/            # Utility functions
│   ├── logger.ts
│   ├── metrics.ts
│   └── helpers.ts
└── index.ts          # Worker entry point
```

## Performance Characteristics

- **Cold Start**: < 100ms (edge Workers)
- **Cache Hit**: < 50ms (KV lookup)
- **Cache Miss**: 200-800ms (vector search + computation)
- **Ingestion**: < 1s (parallel writes with compensation)
- **Vector Dimensions**: 1536 (OpenAI text-embedding-3-small)
- **Recommendation List Size**: 20 items (configurable)

## Roadmap

- [ ] Multi-modal embeddings (images, audio)
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
