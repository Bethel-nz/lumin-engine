declare const queueMicrotask: (callback: () => void) => void;

import { Index } from '@upstash/vector';
import { hashSync } from 'bcrypt-edge';
import { Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { cors } from 'hono/cors';
import OpenAI from 'openai';
import { z } from 'zod';
import tags from './tags.json';

type Bindings = {
  // biome-ignore lint/correctness/noUndeclaredVariables: <explanation>
  DB: D1Database;
  // biome-ignore lint/correctness/noUndeclaredVariables: <explanation>
  CACHE: KVNamespace;
  VECTOR_URL: string;
  VECTOR_TOKEN: string;
  X_APP_KEY: string;
  OPENAI_API_KEY: string;
};

const WEIGHTS: Record<string, number> = {
  click: 1,
  like: 2,
  view: 0.5,
  select_tags: 5,
  dislike: -1,
};
// const DECAY_DAYS = 30;
const app = new Hono<{ Bindings: Bindings }>();

// Retry utility with exponential backoff and jitter
const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> => {
  let attempts = 0;

  const delay = (ms: number) =>
    new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (Date.now() - start >= ms) {
          resolve(undefined);
        } else {
          queueMicrotask(check);
        }
      };
      queueMicrotask(check);
    });

  while (attempts < maxRetries) {
    try {
      return await fn();
    } catch (e: unknown) {
      const error = e as Error;
      attempts++;

      if (
        attempts === maxRetries ||
        (!error.message.includes('network') &&
          !error.message.includes('timeout'))
      ) {
        throw error;
      }

      const maxDelay = baseDelayMs * 2 ** attempts;
      const jitteredDelay = Math.floor(Math.random() * maxDelay);

      await delay(jitteredDelay);
    }
  }

  throw new Error('Max retries reached');
};

async function generateHash(data: string): Promise<string> {
  return await hashSync(data, 8);
}

// Stable hash for A/B testing
const hashCode = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

// A/B test group assignment
const getABTestGroup = async (
  userId: string,
  env: Bindings
): Promise<'A' | 'B'> => {
  const cachedGroup = await env.CACHE.get(`ab_group:${userId}`);
  if (cachedGroup) return cachedGroup as 'A' | 'B';
  const group = hashCode(userId) % 2 === 0 ? 'A' : 'B';
  await env.CACHE.put(`ab_group:${userId}`, group, { expirationTtl: 2592000 });
  return group;
};

/**
 * Validates input data against a Zod schema.
 * @param data - The input data.
 * @param schema - The Zod schema to validate against.
 * @returns Validated data.
 * @throws ZodError if validation fails.
 */
const validateInput = <T>(data: unknown, schema: z.ZodSchema<T>): T =>
  schema.parse(data);

// Input schemas
const ingestEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  host: z.string().optional(),
});
const logInteractionSchema = z.object({
  user_id: z.string(),
  event_id: z.string(),
  action: z.string(),
  tags: z.array(z.string()).optional(),
});

// CORS and rate limiting
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowedWebOrigins = ['http://localhost:3000'];
      const appKey = c.req.header('X-App-Key');
      if (appKey && appKey === c.env.X_APP_KEY) {
        return '*';
      }
      return allowedWebOrigins.includes(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-App-Key'],
  })
);
app.use(
  '*',
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    keyGenerator: async (c) => {
      return (await c.req.header('Origin')) ?? 'default';
    },
  })
);
const userRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  keyGenerator: (c) => c.req.param('userId') || 'anonymous',
});

app.get('/', (c) => c.text('Welcome to Lumin!'));

/**
 * Ingests a new event into the recommendation system using OpenAI embeddings.
 */
app.post('/ingest-event', async (c) => {
  const body = await c.req.json();
  try {
    const {
      id,
      title,
      tags: eventTags,
      host,
    } = validateInput(body, ingestEventSchema);
    const vectorIndex = new Index({
      url: c.env.VECTOR_URL,
      token: c.env.VECTOR_TOKEN,
    });
    const openai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY });

    const { data } = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: `${title} ${eventTags.join(' ')}`,
    });
    const vector = data[0].embedding;

    await withRetry(() =>
      vectorIndex.upsert([
        { id, vector, metadata: { title, tags: eventTags, host } },
      ])
    );
    return c.json({ success: true }, 201);
  } catch (e: unknown) {
    const error = e as Error;
    return c.json({ error: error.message }, 400);
  }
});

/**
 * Logs user interactions with events or profile setup.
 */
app.post('/log-interactions', async (c) => {
  const body = await c.req.json();
  try {
    const { user_id, event_id, action, tags } = validateInput(
      body,
      logInteractionSchema
    );
    const weight = WEIGHTS[action] || 0;

    const userExists = await c.env.DB.prepare(
      'SELECT 1 FROM interactions WHERE user_id = ? LIMIT 1'
    )
      .bind(user_id)
      .first();
    if (!userExists) {
      await c.env.DB.prepare(
        'INSERT INTO interactions (user_id, event_id, action, weight, timestamp) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(user_id, 'initial_signup', 'signup', 0, Date.now())
        .run();
    }

    await c.env.DB.prepare(
      'INSERT INTO interactions (user_id, event_id, action, weight, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(user_id, event_id, action, weight, Date.now())
      .run();

    if (tags && action === 'select_tags') {
      await c.env.CACHE.put(`user_tags:${user_id}`, JSON.stringify(tags), {
        expirationTtl: 2592000,
      });
    }

    await c.env.CACHE.delete(`recs:${user_id}`);
    return c.json({ success: true }, 201);
  } catch (e: unknown) {
    const error = e as Error;
    return c.json({ error: error.message }, 400);
  }
});

/**
 * Computes a user vector using OpenAI embeddings based on interactions and tags.
 */
async function computeUserVector(
  userId: string,
  env: Bindings
): Promise<number[]> {
  const interactions = await env.DB.prepare(
    'SELECT event_id, action, SUM(weight) as total_weight, MAX(timestamp) as latest FROM interactions WHERE user_id = ? GROUP BY event_id, action'
  )
    .bind(userId)
    .all();

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  if (
    !interactions.results.length ||
    interactions.results.every(
      //@ts-ignore
      (r) => r.action === 'signup' || r.action === 'select_tags'
    )
  ) {
    const cachedTags = await env.CACHE.get(`user_tags:${userId}`);
    const selectedTags = cachedTags ? JSON.parse(cachedTags) : [];
    if (!selectedTags.length) {
      return new Array(1536).fill(0);
    }

    const { data } = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: selectedTags.join(' '),
    });
    return data[0].embedding;
  }

  const cachedTags = await env.CACHE.get(`user_tags:${userId}`);
  const selectedTags = cachedTags ? JSON.parse(cachedTags) : [];
  //@ts-ignore
  const eventIds = interactions.results.map((r) => r.event_id);
  const vectorIndex = new Index({
    url: env.VECTOR_URL,
    token: env.VECTOR_TOKEN,
  });
  const vectors = await withRetry(() =>
    vectorIndex.fetch(eventIds as string[] | number[])
  );
  const interactionText = interactions.results
    //@ts-ignore
    .map((r: { event_id: string; action: string }) => {
      //@ts-ignore
      const eventTags = vectors[r.event_id]?.metadata?.tags || [];
      return `${(eventTags as (string | number)[]).join(' ')} ${r.action}`;
    })
    .join(' ');

  const { data } = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: interactionText,
  });
  let userVector = data[0].embedding;

  if (selectedTags.length) {
    const { data: tagData } = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: selectedTags.join(' '),
    });
    const tagVector = tagData[0].embedding;
    const tagInfluence = 0.3;
    userVector = userVector.map(
      (v, i) => v * (1 - tagInfluence) + tagVector[i] * tagInfluence
    );
  }

  return userVector;
}

/**
 * Retrieves personalized recommendations for a user with hash-based caching and randomization.
 */
app.get('/get-recommendations/:userId', userRateLimiter, async (c) => {
  const userId = c.req.param('userId');
  const vectorIndex = new Index({
    url: c.env.VECTOR_URL,
    token: c.env.VECTOR_TOKEN,
  });

  try {
    const cacheKey = `recs:${userId}`;
    const hashKey = `recs_hash:${userId}`;
    const cachedRecs = await c.env.CACHE.get(cacheKey);
    const cachedHash = await c.env.CACHE.get(hashKey);

    const userVector = await computeUserVector(userId, c.env);
    const recs = await withRetry(() =>
      vectorIndex.query({ vector: userVector, topK: 15, includeMetadata: true })
    );
    const diverseRecs = recs
      .slice(0, 8)
      .concat(recs.slice(-2).map((r) => ({ ...r, diversified: true })));
    const enriched = diverseRecs.map((r) => ({
      event_id: r.id,
      score: r.score,
    }));
    const newRecsStr = JSON.stringify(enriched);
    const newHash = await generateHash(newRecsStr);

    if (cachedHash && cachedHash === newHash && cachedRecs) {
      const parsedCachedRecs = JSON.parse(cachedRecs);
      const randomizedRecs = [...parsedCachedRecs].sort(
        () => Math.random() - 0.5
      );
      return c.json(randomizedRecs);
    }
    await c.env.CACHE.put(cacheKey, newRecsStr, { expirationTtl: 1800 });
    await c.env.CACHE.put(hashKey, newHash, { expirationTtl: 1800 });
    return c.json(enriched);
  } catch (e: unknown) {
    const error = e as Error;
    return c.json(
      { error: 'Internal server error', message: error.message },
      500
    );
  }
});

/**
 * Searches for events based on a keyword query.
 */
app.get('/search', async (c) => {
  const { query } = c.req.query();
  try {
    if (!query) {
      return c.json({ error: 'Query required' }, 400);
    }
    const vectorIndex = new Index({
      url: c.env.VECTOR_URL,
      token: c.env.VECTOR_TOKEN,
    });
    const openai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY });

    const { data } = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query,
    });
    const queryVector = data[0].embedding;

    const recs = await withRetry(() =>
      vectorIndex.query({
        vector: queryVector,
        topK: 10,
        includeMetadata: true,
      })
    );

    type VectorMetadata = {
      title: string;
      tags: string[];
    };

    const results = recs.map((r) => {
      const metadata = r.metadata as VectorMetadata;
      return {
        event_id: r.id,
        title: metadata.title,
        tags: metadata.tags,
        score: r.score,
      };
    });

    return c.json({ results });
  } catch (e: unknown) {
    const error = e as Error;
    return c.json({ error: error.message }, 400);
  }
});

/**
 * Updates tag vectors based on recent user interactions (scheduled process).
 */
async function updateTagVector(
  tag: string,
  recentInteractions: Array<{ event_id: string }>,
  env: Bindings
) {
  const currentVector =
    tags[tag as keyof typeof tags] || new Array(1536).fill(0);
  const vectorIndex = new Index({
    url: env.VECTOR_URL,
    token: env.VECTOR_TOKEN,
  });

  const eventVectors = await Promise.all(
    recentInteractions.map(async (inter) => {
      const eventId = inter.event_id;
      const result = await vectorIndex.fetch([eventId]);
      //@ts-ignore
      return result[eventId]?.vector || new Array(1536).fill(0);
    })
  );

  const newVector = eventVectors
    .reduce(
      (acc: number[], vec: number[]) => acc.map((v, i) => v + vec[i]),
      new Array(1536).fill(0)
    )
    .map((v: number) => v / eventVectors.length);

  const learningRate = 0.2;
  const updatedVector = currentVector.map(
    (val: number, i: number) =>
      val * (1 - learningRate) + newVector[i] * learningRate
  );

  tags[tag as keyof typeof tags] = updatedVector;
  await env.CACHE.put('updated_tags', JSON.stringify(tags));
}

export default {
  fetch: app.fetch,
  scheduled: async (controller: ScheduledController, env: Bindings) => {
    if (controller.cron === '*/30 * * * *') {
      const allTags = await env.DB.prepare(
        'SELECT DISTINCT tag FROM events'
      ).all();
      for (const tagResult of allTags.results) {
        const tag = tagResult.tag;
        const recentInteractions = await env.DB.prepare(
          'SELECT event_id FROM interactions JOIN events ON interactions.event_id = events.id WHERE tag = ? ORDER BY timestamp DESC LIMIT 100'
        )
          .bind(tag)
          .all();
        if (!tag || !recentInteractions.results) return;
        await updateTagVector(
          tag as string,
          recentInteractions.results as Array<{ event_id: string }>,
          env
        );
      }
    }
  },
};
