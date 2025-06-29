import { Index, type Vector } from '@upstash/vector';
import { hashSync } from 'bcrypt-edge';

import { type Context, Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { cors } from 'hono/cors';
import OpenAI from 'openai';
import { z } from 'zod';

// --- Type Definitions ---

interface EnvBindings {
  DB: D1Database;
  CACHE: KVNamespace;
  TAG_VECTORS_KV: KVNamespace;
  VECTOR_URL: string;
  VECTOR_TOKEN: string;
  X_APP_KEY: string;
  OPENAI_API_KEY: string;
}

interface Interaction {
  user_id: string;
  event_id: string;
  action: string;
  weight: number;
  timestamp: number;
}

interface InteractionResult {
  event_id: string;
  action: string;
  total_weight: number;
  latest: number;
}

interface VectorMetadata {
  title: string;
  tags: string[];
  host?: string;
}

interface TagVectors {
  [key: string]: number[];
}

interface EnrichedRecommendation {
  event_id: string;
  score: number;
  diversified: boolean;
}

const WEIGHTS: Record<string, number> = {
  click: 1,
  like: 2,
  view: 0.5,
  select_tags: 5,
  dislike: -1,
  signup: 0,
};

const EMBEDDING_MODEL = 'text-embedding-ada-002';
const EMBEDDING_DIMENSIONS = 1536;

const app = new Hono<{ Bindings: EnvBindings }>();

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> => {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      return await fn();
    } catch (e: unknown) {
      const error = e as Error;
      attempts++;
      if (
        attempts === maxRetries ||
        (!error.message.includes('network') &&
          !error.message.includes('timeout') &&
          !(error instanceof OpenAI.APIError && error.status === 500) &&
          !(e instanceof Error && e.message.includes('fetch failed')))
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

const generateHash = (data: string): string => {
  return hashSync(data, 8);
};

const captureWorkerError = <T>(
  error: Error,
  context?: Record<string, T>
): void => {
  // biome-ignore lint/suspicious/noConsole: Worker logging for monitoring
  console.error(`Worker Error: ${error.message}`, {
    error: error.stack,
    ...context,
  });

  // TODO: Send to monitoring service (e.g., Sentry, Datadog, etc.)
  // This could be implemented with fetch to external monitoring APIs
};

const hashCode = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const getABTestGroup = async (
  userId: string,
  cache: KVNamespace
): Promise<'A' | 'B'> => {
  const cacheKey = `ab_group:${userId}`;
  const cachedGroup = await cache.get(cacheKey);
  if (cachedGroup === 'A' || cachedGroup === 'B') {
    return cachedGroup;
  }
  const group = hashCode(userId) % 2 === 0 ? 'A' : 'B';
  await cache.put(cacheKey, group, { expirationTtl: 2592000 });
  return group;
};

const validateInput = <T>(data: unknown, schema: z.ZodSchema<T>): T => {
  return schema.parse(data);
};

const handleError = (
  _c: Context,
  error: unknown,
  message = 'Bad Request',
  status = 400
): Response => {
  let responseBody: object;
  let responseStatus = status;

  if (error instanceof z.ZodError) {
    responseBody = { error: 'Validation failed', details: error.errors };
    responseStatus = 400;
  } else {
    responseBody = {
      error: message,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  return new Response(JSON.stringify(responseBody), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  });
};

const getOpenAIClient = (c: Context<{ Bindings: EnvBindings }>): OpenAI => {
  return new OpenAI({ apiKey: c.env.OPENAI_API_KEY });
};

const getVectorIndex = (c: Context<{ Bindings: EnvBindings }>): Index => {
  return new Index({ url: c.env.VECTOR_URL, token: c.env.VECTOR_TOKEN });
};

const generateEmbedding = async (
  text: string,
  openai: OpenAI
): Promise<number[]> => {
  if (!text?.trim()) {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }
  try {
    const { data } = await withRetry(() =>
      openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      })
    );
    return data[0]?.embedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
  } catch (error) {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }
};

const checkUserExists = async (
  db: D1Database,
  userId: string
): Promise<boolean> => {
  const result = await db
    .prepare('SELECT 1 FROM interactions WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first();
  return !!result;
};

const insertInteraction = async (
  db: D1Database,
  data: Omit<Interaction, 'weight'>
): Promise<void> => {
  const weight = WEIGHTS[data.action] ?? 0;
  await db
    .prepare(
      'INSERT INTO interactions (user_id, event_id, action, weight, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(data.user_id, data.event_id, data.action, weight, data.timestamp)
    .run();
};

const fetchEventVectors = async (
  vectorIndex: Index,
  eventIds: string[]
): Promise<Record<string, Vector | null>> => {
  if (!eventIds || eventIds.length === 0) {
    return {};
  }
  const vectors = await withRetry(() => vectorIndex.fetch(eventIds));
  const result: Record<string, Vector | null> = {};
  eventIds.forEach((id, index) => {
    result[id] = vectors[index];
  });
  return result;
};

const ingestEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tags: z.array(z.string()).min(1),
  host: z.string().optional(),
});

const logInteractionSchema = z
  .object({
    user_id: z.string().min(1),
    event_id: z.string().min(1),
    action: z.string().refine((val) => Object.keys(WEIGHTS).includes(val), {
      message: 'Invalid action type',
    }),
    tags: z.array(z.string()).optional(),
  })
  .refine(
    (data) =>
      !(
        data.action === 'select_tags' &&
        (!data.tags || data.tags.length === 0)
      ),
    {
      message:
        "Tags array must be provided and non-empty for 'select_tags' action",
      path: ['tags'],
    }
  );

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowedWebOrigins = [
        'http://localhost:3000',
        'https://synaxis-app.vercel.app',
      ];
      const appKey = c.req.header('X-App-Key');
      if (appKey && appKey === c.env.X_APP_KEY) {
        return origin;
      }
      return allowedWebOrigins.includes(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-App-Key', 'Authorization'],
    credentials: true,
  })
);

app.use(
  '*',
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    keyGenerator: (c) =>
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For') ||
      'ip_unknown',
    message: () => ({
      error:
        'Too many requests from this IP, please try again after 15 minutes',
    }),
  })
);

const userRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  keyGenerator: (c) => c.req.param('userId') || 'user_unknown',
  message: () => ({
    error: 'Too many requests for this user, please try again after 15 minutes',
  }),
});

// --- Routes ---

app.get('/', (c) => {
  return c.text('Welcome to Lumin Recommendation Service!');
});

app.post('/ingest-event', async (c) => {
  try {
    const body = await c.req.json();
    const { id, title, tags, host } = validateInput(body, ingestEventSchema);

    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);

    const embeddingText = `${title} ${tags.join(' ')}`;
    const vector = await generateEmbedding(embeddingText, openai);

    if (vector.every((v) => v === 0)) {
      throw new Error('Failed to generate a valid embedding for the event.');
    }

    await withRetry(() =>
      vectorIndex.upsert([
        { id, vector, metadata: { title, tags, host: host ?? '' } },
      ])
    );

    return c.json({ success: true, message: `Event ${id} ingested.` }, 201);
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to ingest event');
  }
});

app.post('/log-interactions', async (c) => {
  try {
    const body = await c.req.json();
    const interactionData = validateInput(body, logInteractionSchema);
    const { user_id, event_id, action, tags } = interactionData;

    const userExists = await checkUserExists(c.env.DB, user_id);
    if (!userExists) {
      await insertInteraction(c.env.DB, {
        user_id,
        event_id: 'initial_signup',
        action: 'signup',
        timestamp: Date.now(),
      });
    }

    await insertInteraction(c.env.DB, {
      user_id,
      event_id,
      action,
      timestamp: Date.now(),
    });

    if (action === 'select_tags' && tags) {
      await c.env.CACHE.put(`user_tags:${user_id}`, JSON.stringify(tags), {
        expirationTtl: 2592000,
      });
    }

    await c.env.CACHE.delete(`recs:${user_id}`);
    await c.env.CACHE.delete(`recs_hash:${user_id}`);

    return c.json(
      { success: true, message: `Interaction logged for user ${user_id}` },
      201
    );
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to log interaction');
  }
});

app.get('/get-recommendations/:userId', userRateLimiter, async (c) => {
  const userId = c.req.param('userId');
  if (!userId) {
    return handleError(c, null, 'User ID is required', 400);
  }

  try {
    const cacheKey = `recs:${userId}`;
    const hashKey = `recs_hash:${userId}`;
    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);

    const userTagsStr = await c.env.CACHE.get(`user_tags:${userId}`);
    const userSelectedTags: Set<string> = userTagsStr
      ? new Set(JSON.parse(userTagsStr))
      : new Set();
    const hasUserTags = userSelectedTags.size > 0;

    const abGroup = await getABTestGroup(userId, c.env.CACHE);
    const initialTopK = abGroup === 'A' ? 40 : 50;
    const useDiversification = abGroup === 'A';

    const userVector = await computeUserVector(
      userId,
      c.env,
      openai,
      vectorIndex
    );

    if (userVector.every((v) => v === 0)) {
      return c.json([]);
    }

    const queryResults = await withRetry(() =>
      vectorIndex.query({
        vector: userVector,
        topK: initialTopK,
        includeMetadata: true,
      })
    );

    let filteredCandidates = queryResults;
    if (hasUserTags) {
      filteredCandidates = queryResults.filter((result) => {
        const metadata = result.metadata as Partial<VectorMetadata> | undefined;
        if (metadata?.tags && Array.isArray(metadata.tags)) {
          return metadata.tags.some(
            (eventTag) =>
              typeof eventTag === 'string' && userSelectedTags.has(eventTag)
          );
        }
        return false;
      });
    }

    if (filteredCandidates.length === 0) {
      return c.json([]);
    }

    let finalRecs = filteredCandidates;
    const targetDiversificationCount = 8 + 2;
    if (useDiversification && finalRecs.length >= targetDiversificationCount) {
      const diverseSelection = finalRecs
        .slice(0, 8)
        .concat(finalRecs.slice(-2));
      finalRecs = diverseSelection.map((r, index) => ({
        ...r,
        diversified: index >= 8,
      }));
    } else {
      finalRecs = finalRecs.slice(0, 15);
    }

    const enriched: EnrichedRecommendation[] = finalRecs.map((r) => ({
      event_id: r.id.toString(),
      score: r.score,
      diversified:
        (r as Vector & { diversified?: boolean }).diversified ?? false,
    }));

    const newRecsStr = JSON.stringify(enriched);
    const newHash = generateHash(newRecsStr);

    const cachedHash = await c.env.CACHE.get(hashKey);
    if (cachedHash && cachedHash === newHash) {
      const cachedRecs = await c.env.CACHE.get(cacheKey);
      if (cachedRecs) {
        const parsedCachedRecs: EnrichedRecommendation[] =
          JSON.parse(cachedRecs);
        const topN = parsedCachedRecs
          .slice(0, 5)
          .sort(() => Math.random() - 0.5);
        const rest = parsedCachedRecs.slice(5);
        return c.json(topN.concat(rest));
      }
    }

    await c.env.CACHE.put(cacheKey, newRecsStr, { expirationTtl: 1800 });
    await c.env.CACHE.put(hashKey, newHash, { expirationTtl: 1800 });

    return c.json(enriched);
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to get recommendations', 500);
  }
});

app.get('/search', async (c) => {
  const { query } = c.req.query();
  if (!query) {
    return handleError(c, null, 'Query parameter is required', 400);
  }

  try {
    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);

    const queryVector = await generateEmbedding(query, openai);
    if (queryVector.every((v) => v === 0)) {
      throw new Error(
        'Failed to generate a valid embedding for the search query.'
      );
    }

    const searchResults = await withRetry(() =>
      vectorIndex.query({
        vector: queryVector,
        topK: 10,
        includeMetadata: true,
      })
    );

    const results = searchResults.map((r) => {
      const metadata = r.metadata as VectorMetadata | undefined;
      return {
        event_id: r.id,
        title: metadata?.title ?? 'N/A',
        tags: metadata?.tags ?? [],
        score: r.score,
      };
    });

    return c.json({ results });
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to perform search');
  }
});

async function buildInteractionVector(
  interactions: Omit<InteractionResult, 'total_weight' | 'latest'>[],
  vectorIndex: Index,
  openai: OpenAI
): Promise<number[]> {
  if (!interactions.length) return new Array(EMBEDDING_DIMENSIONS).fill(0);

  const eventIds = [...new Set(interactions.map((r) => r.event_id))];
  const eventVectors = await fetchEventVectors(vectorIndex, eventIds);

  const interactionTextParts: string[] = [];
  for (const r of interactions) {
    const vectorData = eventVectors[r.event_id];
    const metadata = vectorData?.metadata as VectorMetadata | undefined;
    if (metadata?.tags) {
      interactionTextParts.push(`${metadata.tags.join(' ')} ${r.action}`);
    }
  }

  return interactionTextParts.length > 0
    ? await generateEmbedding(interactionTextParts.join(' . '), openai)
    : new Array(EMBEDDING_DIMENSIONS).fill(0);
}

function combineVectors(
  interactionVector: number[],
  tagVector: number[],
  hasInteractions: boolean,
  hasTags: boolean
): number[] {
  if (!hasInteractions && !hasTags)
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  if (!hasInteractions) return tagVector;
  if (!hasTags) return interactionVector;

  const tagInfluence = 0.3;
  return interactionVector.map(
    (v, i) => v * (1 - tagInfluence) + tagVector[i] * tagInfluence
  );
}

async function computeUserVector(
  userId: string,
  env: EnvBindings,
  openai: OpenAI,
  vectorIndex: Index
): Promise<number[]> {
  const interactionsQuery = env.DB.prepare(
    'SELECT event_id, action FROM interactions WHERE user_id = ? AND action != ?'
  ).bind(userId, 'signup');
  const interactionsResult =
    await interactionsQuery.all<
      Omit<InteractionResult, 'total_weight' | 'latest'>
    >();

  const cachedTags = await env.CACHE.get(`user_tags:${userId}`);
  const selectedTags: string[] = cachedTags ? JSON.parse(cachedTags) : [];

  const [interactionVector, tagVector] = await Promise.all([
    buildInteractionVector(interactionsResult.results, vectorIndex, openai),
    selectedTags.length
      ? generateEmbedding(selectedTags.join(' '), openai)
      : Promise.resolve(new Array(EMBEDDING_DIMENSIONS).fill(0)),
  ]);

  return combineVectors(
    interactionVector,
    tagVector,
    interactionsResult.results.length > 0,
    selectedTags.length > 0
  );
}

async function updateSingleTagVector(
  tag: string,
  env: EnvBindings,
  vectorIndex: Index
): Promise<void> {
  const interactionsQuery = await env.DB.prepare(
    `SELECT i.event_id
      FROM interactions i
      JOIN events e ON i.event_id = e.id
      WHERE e.tag = ? AND i.action IN ('like', 'click')
      ORDER BY i.timestamp DESC
      LIMIT 50`
  )
    .bind(tag)
    .all<{ event_id: string }>();

  if (!interactionsQuery.results || interactionsQuery.results.length === 0) {
    return;
  }

  const eventIds = [
    ...new Set(interactionsQuery.results.map((i) => i.event_id)),
  ];
  const eventVectorsData = await fetchEventVectors(vectorIndex, eventIds);
  const validEventVectors = Object.values(eventVectorsData)
    .filter((v): v is Vector & { vector: number[] } => !!v?.vector)
    .map((v) => v.vector);

  if (validEventVectors.length === 0) {
    return;
  }

  const averageEventVector = validEventVectors
    .reduce((acc, vec) => {
      return acc.map((val, i) => val + (vec[i] ?? 0));
    }, new Array(EMBEDDING_DIMENSIONS).fill(0))
    .map((v) => v / validEventVectors.length);

  const existingTagsStr = await env.TAG_VECTORS_KV.get('all_tags');
  const existingTags: TagVectors = existingTagsStr
    ? JSON.parse(existingTagsStr)
    : {};

  const currentTagVector =
    existingTags[tag] || new Array(EMBEDDING_DIMENSIONS).fill(0);

  const learningRate = 0.1;
  const updatedVector = currentTagVector.map(
    (val, i) => val * (1 - learningRate) + averageEventVector[i] * learningRate
  );

  existingTags[tag] = updatedVector;

  await env.TAG_VECTORS_KV.put('all_tags', JSON.stringify(existingTags));
}

export default {
  fetch: app.fetch,
  scheduled: async (
    controller: ScheduledController,
    env: EnvBindings,
    ctx: ExecutionContext
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
  ): Promise<void> => {
    if (controller.cron === '*/30 * * * *') {
      try {
        const vectorIndex = new Index({
          url: env.VECTOR_URL,
          token: env.VECTOR_TOKEN,
        });

        const timeWindowMs = 24 * 60 * 60 * 1000;
        const cutoffTimestamp = Date.now() - timeWindowMs;

        const recentEventsQuery = await env.DB.prepare(
          `SELECT DISTINCT event_id
            FROM interactions
            WHERE timestamp > ? AND action IN ('like', 'click', 'view')
            LIMIT 500`
        )
          .bind(cutoffTimestamp)
          .all<{ event_id: string }>();

        if (
          !recentEventsQuery.results ||
          recentEventsQuery.results.length === 0
        ) {
          return;
        }

        const recentEventIds = recentEventsQuery.results.map((r) => r.event_id);

        const eventVectorsData = await fetchEventVectors(
          vectorIndex,
          recentEventIds
        );

        const activeTags = new Set<string>();
        for (const vectorData of Object.values(eventVectorsData)) {
          if (vectorData?.metadata) {
            const metadata = vectorData.metadata as
              | Partial<VectorMetadata>
              | undefined;
            if (metadata?.tags && Array.isArray(metadata.tags)) {
              for (const tag of metadata.tags) {
                if (typeof tag === 'string' && tag.trim() !== '') {
                  activeTags.add(tag.trim());
                }
              }
            }
          }
        }

        if (activeTags.size === 0) {
          return;
        }

        for (const tag of activeTags) {
          ctx.waitUntil(updateSingleTagVector(tag, env, vectorIndex));
        }
      } catch (error) {
        captureWorkerError(error as Error, {
          context: 'scheduled-tag-vector-update',
          cron: controller.cron,
        });
      }
    }
  },
};
