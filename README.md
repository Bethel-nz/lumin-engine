# Lumin

Lumin is an edge-based recommendation service built with Cloudflare Workers. It processes user interactions and event data to provide personalized recommendations for community events.

## Features

- Real-time recommendation processing at the edge
- User interaction tracking and analysis
- Event similarity search using vector embeddings
- A/B testing support
- Rate limiting and error handling

## Tech Stack

- Cloudflare Workers (Edge Computing)
- Hono (Web Framework)
- Upstash Vector (Vector Database)
- OpenAI Embeddings (Text Processing)
- D1 Database (Edge SQL)

## Getting Started

### Prerequisites

- Node.js 18+
- Cloudflare Workers account
- Upstash Vector account
- OpenAI API key

### Environment Setup

Create a `.dev.vars` file:
```env
VECTOR_URL=your_upstash_vector_url
VECTOR_TOKEN=your_upstash_vector_token
OPENAI_API_KEY=your_openai_key
X_APP_KEY=your-application-key
```

Configure your `wrangler.toml` with:
- D1 database ID
- KV namespace ID
- Environment variables

### Development

```bash
npm install    # Install dependencies
npm run dev    # Start local development server
```

### Deployment

```bash
npm run deploy # Deploy to Cloudflare Workers
```

## API Endpoints

### GET /get-recommendations/:userId

Get personalized event recommendations based on user interactions and preferences.

### POST /log-interactions

Log user interactions with events:

```typescript
{
  user_id: string
  event_id: string
  action: "view" | "click" | "like" | "dislike" | "select_tags"
  tags?: string[]
}
```

### POST /ingest-event

Add new events to the recommendation system:

```typescript
{
  id: string
  title: string
  tags: string[]
  host?: string
}
```

### GET /search

Search events by keyword query, returns vector similarity matches.

## Security

- Rate limiting per origin and user
- API key authentication
- CORS protection
- Edge-based request validation

## Architecture

- Uses OpenAI embeddings for semantic understanding
- Vector similarity search for recommendations
- Edge SQLite for interaction tracking
- KV for caching and A/B testing
- Scheduled tag vector updates

view full architecture [here](https://excalidraw.com/#json=T0FgGo0V8KY4nhcWL2IHG,TX5w1r5KBh0glXcOy84EHw)
