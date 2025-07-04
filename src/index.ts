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

interface UserDemographics {
  // Example demographic fields
  country: string | null;
  interests: string[];
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

interface TemporalPattern {
  hour: number;
  day_of_week: number;
  interaction_count: number;
  like_rate: number;
}

interface UserBehaviorProfile {
  user_id: string;
  interaction_velocity: number;
  tag_diversity: number;
  engagement_depth: number;
  preferred_times: number[];
  social_level: number;
  exploration_success_rate: number;
}

interface ExplorationItem {
  event_id: string;
  score: number;
  exploration_type: 'temporal' | 'anti_correlated' | 'trending' | 'serendipity';
  confidence: number;
}

const WEIGHTS: Record<string, number> = {
  click: 1,
  like: 2,
  view: 0.5,
  select_tags: 5,
  dislike: -1,
  signup: 0,
};

const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 3072;

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
        input: text.trim(),
      })
    );
    return data[0]?.embedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
  } catch (error) {
    captureWorkerError(error as Error, { context: 'generateEmbedding', text });
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

const getUserDemographics = async (
  db: D1Database,
  userId: string
): Promise<UserDemographics | null> => {
  const result = await db
    .prepare('SELECT country, interests FROM user_profiles WHERE user_id = ?')
    .bind(userId)
    .first();
  return result
    ? {
        country: result?.country as string | null,
        interests: result?.interests as string[],
      }
    : null;
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

    // **ENHANCEMENT**: Include host in the embedding text for richer item representation.
    const embeddingText = `${title} ${tags.join(' ')} ${host ? `hosted by ${host}` : ''}`;
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

    // **ENHANCEMENT**: Use the new hybrid vector computation.
    const userVector = await computeHybridUserVector(
      userId,
      c.env,
      openai,
      vectorIndex
    );

    if (userVector.every((v) => v === 0)) {
      // Return trending items as a fallback for new users or users with no vector
      const trending = await getTrendingItems(c.env, 15);
      const trendingRecs = trending.map((item) => ({
        ...item,
        diversified: false,
      }));
      return c.json(trendingRecs);
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

    let finalRecs = filteredCandidates.map((r) => ({
      ...r,
      diversified: false,
    }));
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

    // Convert to EnrichedRecommendation format first
    let enriched: EnrichedRecommendation[] = finalRecs.map((r) => ({
      event_id: r.id.toString(),
      score: r.score,
      diversified: r.diversified,
    }));

    // **INTEGRATION**: Inject exploration items into the recommendation list.
    const explorationRate = await getExplorationRate(userId, c.env);
    if (Math.random() < explorationRate) {
      const explorationItems = await Promise.all([
        getAntiCorrelatedRecommendations(userVector, vectorIndex, 1),
        getSerendipityItems(userId, vectorIndex, c.env, 1),
        getTrendingItems(c.env, 1),
      ]);
      enriched = injectExploration(
        enriched,
        explorationItems.flat(),
        explorationRate
      );
    }

    await trackExplorationSuccess(userId, enriched, c.env);

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
    captureWorkerError(e as Error, { context: 'get-recommendations' });
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

// **NEW**: Combines multiple vectors with specified weights for the hybrid model.
function combineVectors(
  vectors: { vector: number[]; weight: number }[]
): number[] {
  const totalWeight = vectors.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight === 0) return new Array(EMBEDDING_DIMENSIONS).fill(0);

  const finalVector = new Array(EMBEDDING_DIMENSIONS).fill(0);

  for (const { vector, weight } of vectors) {
    if (vector.length === EMBEDDING_DIMENSIONS) {
      for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
        finalVector[i] += vector[i] * (weight / totalWeight);
      }
    }
  }
  return finalVector;
}

// **NEW**: Implements the collaborative filtering part of the model.
async function getCollaborativeVector(
  userId: string,
  env: EnvBindings,
  openai: OpenAI,
  vectorIndex: Index
): Promise<number[]> {
  // Find users who interacted with the same events as the current user
  const similarUsersQuery = await env.DB.prepare(
    `SELECT
            i2.user_id,
            COUNT(i1.event_id) as common_interactions
        FROM interactions i1
        JOIN interactions i2 ON i1.event_id = i2.event_id AND i1.user_id != i2.user_id
        WHERE i1.user_id = ? AND i1.action IN ('like', 'click')
        GROUP BY i2.user_id
        ORDER BY common_interactions DESC
        LIMIT 5`
  )
    .bind(userId)
    .all<{ user_id: string; common_interactions: number }>();

  if (!similarUsersQuery.results || similarUsersQuery.results.length === 0) {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  // For the top similar users, get their recent liked/clicked items
  const similarUserIds = similarUsersQuery.results.map((u) => u.user_id);
  const placeholders = similarUserIds.map(() => '?').join(',');

  const similarInteractionsQuery = await env.DB.prepare(
    `SELECT event_id, action FROM interactions
        WHERE user_id IN (${placeholders}) AND action IN ('like', 'click')
        ORDER BY timestamp DESC
        LIMIT 30`
  )
    .bind(...similarUserIds)
    .all<Omit<InteractionResult, 'total_weight' | 'latest'>>();

  if (
    !similarInteractionsQuery.results ||
    similarInteractionsQuery.results.length === 0
  ) {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  // Build a single vector representing the preferences of the similar user group
  return buildInteractionVector(
    similarInteractionsQuery.results,
    vectorIndex,
    openai
  );
}

// **ENHANCEMENT**: Computes a hybrid vector from content, collaborative, and explicit signals.
async function computeHybridUserVector(
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

  // Get user demographics
  const demographics = await getUserDemographics(env.DB, userId);
  const demographicsText = demographics
    ? `${demographics.country} ${demographics.interests.join(' ')}`
    : '';

  const [
    interactionVector,
    tagVector,
    collaborativeVector,
    demographicsVector,
  ] = await Promise.all([
    buildInteractionVector(interactionsResult.results, vectorIndex, openai),
    selectedTags.length
      ? generateEmbedding(selectedTags.join(' '), openai)
      : Promise.resolve(new Array(EMBEDDING_DIMENSIONS).fill(0)),
    getCollaborativeVector(userId, env, openai, vectorIndex),
    demographicsText
      ? generateEmbedding(demographicsText, openai)
      : Promise.resolve(new Array(EMBEDDING_DIMENSIONS).fill(0)),
  ]);

  return combineVectors([
    { vector: interactionVector, weight: 0.5 }, // Content-based from own actions
    { vector: tagVector, weight: 0.3 }, // Explicit interests
    { vector: collaborativeVector, weight: 0.2 }, // Collaborative filtering
    { vector: demographicsVector, weight: 0.1 }, // User profile data
  ]);
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

// --- Exploration and Diversification Functions ---

const getExplorationRate = async (
  userId: string,
  env: EnvBindings
): Promise<number> => {
  const interactionCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM interactions WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ count: number }>();

  const recentEngagement = await env.DB.prepare(
    `SELECT AVG(CASE WHEN action IN ('like', 'click') THEN 1 ELSE 0 END) as rate
     FROM interactions 
     WHERE user_id = ? AND timestamp > ?`
  )
    .bind(userId, Date.now() - 7 * 24 * 60 * 60 * 1000)
    .first<{ rate: number }>();

  const baseRate = Math.max(0.1, 0.4 - (interactionCount?.count || 0) * 0.01);

  // Increase exploration if recent engagement is low
  if ((recentEngagement?.rate || 0) < 0.3) {
    return Math.min(0.6, baseRate * 2);
  }

  return baseRate;
};

const analyzeTemporalPatterns = async (
  userId: string,
  env: EnvBindings
): Promise<TemporalPattern[]> => {
  const patterns = await env.DB.prepare(
    `SELECT 
      CAST(strftime('%H', datetime(timestamp/1000, 'unixepoch')) AS INTEGER) as hour,
      CAST(strftime('%w', datetime(timestamp/1000, 'unixepoch')) AS INTEGER) as day_of_week,
      COUNT(*) as interaction_count,
      AVG(CASE WHEN action = 'like' THEN 1 ELSE 0 END) as like_rate
    FROM interactions 
    WHERE user_id = ? AND timestamp > ?
    GROUP BY hour, day_of_week
    HAVING interaction_count >= 2`
  )
    .bind(userId, Date.now() - 30 * 24 * 60 * 60 * 1000)
    .all<TemporalPattern>();

  return patterns.results || [];
};

const getAntiCorrelatedRecommendations = async (
  userVector: number[],
  vectorIndex: Index,
  topK = 2
): Promise<ExplorationItem[]> => {
  const invertedVector = userVector.map((v) => -v);

  const antiResults = await withRetry(() =>
    vectorIndex.query({
      vector: invertedVector,
      topK: topK * 2,
      includeMetadata: true,
    })
  );

  return antiResults.slice(0, topK).map((r) => ({
    event_id: r.id.toString(),
    score: r.score,
    exploration_type: 'anti_correlated',
    confidence: 0.6,
  }));
};

const getTrendingItems = async (
  env: EnvBindings,
  topK = 2
): Promise<ExplorationItem[]> => {
  const trending = await env.DB.prepare(
    `SELECT 
      event_id,
      COUNT(*) as interaction_count,
      AVG(CASE WHEN action IN ('like', 'click') THEN 1 ELSE 0 END) as engagement_rate
    FROM interactions 
    WHERE timestamp > ? AND action IN ('like', 'click', 'view')
    GROUP BY event_id
    HAVING interaction_count >= 3
    ORDER BY (interaction_count * engagement_rate) DESC
    LIMIT ?`
  )
    .bind(Date.now() - 3 * 24 * 60 * 60 * 1000, topK) // Trending over last 3 days
    .all<{
      event_id: string;
      interaction_count: number;
      engagement_rate: number;
    }>();

  return (trending.results || []).map((r) => ({
    event_id: r.event_id,
    score: r.engagement_rate * Math.log(r.interaction_count + 1),
    exploration_type: 'trending',
    confidence: 0.8,
  }));
};

const getSerendipityItems = async (
  userId: string,
  vectorIndex: Index,
  env: EnvBindings,
  topK = 1
): Promise<ExplorationItem[]> => {
  const userTags = await env.CACHE.get(`user_tags:${userId}`);
  const avoidTags: string[] = userTags ? JSON.parse(userTags) : [];

  const randomVector = new Array(EMBEDDING_DIMENSIONS)
    .fill(0)
    .map(() => Math.random() - 0.5);

  const randomResults = await withRetry(() =>
    vectorIndex.query({
      vector: randomVector,
      topK: topK * 5, // Fetch more to allow for filtering
      includeMetadata: true,
    })
  );

  const serendipitous = randomResults
    .filter((r) => {
      const metadata = r.metadata as VectorMetadata | undefined;
      if (!metadata?.tags) return true;
      // Ensure the item is not related to the user's core interests
      return !metadata.tags.some((tag) => avoidTags.includes(tag));
    })
    .slice(0, topK);

  return serendipitous.map((r) => ({
    event_id: r.id.toString(),
    score: Math.random() * 0.5,
    exploration_type: 'serendipity',
    confidence: 0.3,
  }));
};

const injectExploration = (
  mainRecs: EnrichedRecommendation[],
  explorationItems: ExplorationItem[],
  explorationRate: number
): EnrichedRecommendation[] => {
  if (explorationItems.length === 0) return mainRecs;

  const result = [...mainRecs];
  const slots = [2, 5, 8]; // Strategic positions to inject exploration items

  let expIndex = 0;
  for (const slot of slots) {
    if (
      slot < result.length &&
      expIndex < explorationItems.length &&
      Math.random() < explorationRate // Use rate to decide if injection happens
    ) {
      result.splice(slot, 0, {
        // Use splice to insert instead of replace
        event_id: explorationItems[expIndex].event_id,
        score: explorationItems[expIndex].score,
        diversified: true,
      });
      expIndex++;
    }
  }

  return result;
};

const trackExplorationSuccess = async (
  userId: string,
  recommendations: EnrichedRecommendation[],
  env: EnvBindings
): Promise<void> => {
  // Store exploration items for later success measurement
  const explorationItems = recommendations
    .filter((r) => r.diversified)
    .map((r) => r.event_id);

  if (explorationItems.length > 0) {
    await env.CACHE.put(
      `exploration_tracking:${userId}:${Date.now()}`,
      JSON.stringify(explorationItems),
      { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
    );
  }
};

// --- Default Export and Scheduled Tasks ---

export default {
  fetch: app.fetch,
  scheduled: async (
    controller: ScheduledController,
    env: EnvBindings,
    ctx: ExecutionContext
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Scheduled task has multiple logic paths
  ): Promise<void> => {
    if (controller.cron === '*/30 * * * *') {
      // Update tag vectors every 30 minutes
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
