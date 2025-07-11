import type { Context } from 'hono';
import { getOpenAIClient, getVectorIndex } from '../lib/clients';
import {
  getAntiCorrelatedRecommendations,
  getExplorationRate,
  getSerendipityItems,
  getTrendingItems,
  injectExploration,
  trackExplorationSuccess,
} from '../services/exploration';
import { computeHybridUserVector } from '../services/recommendations';
import type {
  EnrichedRecommendation,
  EnvBindings,
  VectorMetadata,
} from '../types';
import {
  captureWorkerError,
  generateHash,
  getABTestGroup,
  handleError,
  withRetry,
} from '../utils';

export const getRecommendationsRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  const userId = c.req.param('userId');
  if (!userId) {
    return handleError(c, null, 'User ID is required', 400);
  }

  try {
    const cacheKey = `recs:${userId}`;
    const cachedRecs = await c.env.CACHE.get(cacheKey);
    if (cachedRecs) {
      const recs = JSON.parse(cachedRecs);
      return c.json(recs);
    }

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

    // Get hybrid user vector using all recommendation strategies
    const userVector = await computeHybridUserVector(
      userId,
      c.env,
      openai,
      vectorIndex
    );

    if (userVector.every((v) => v === 0)) {
      const trending = await getTrendingItems(c.env, 15);
      const trendingRecs = trending.map((item) => ({
        event_id: item.event_id,
        score: item.score,
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

    if (useDiversification && finalRecs.length >= 10) {
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

    let enriched: EnrichedRecommendation[] = finalRecs.map((r) => ({
      event_id: r.id.toString(),
      score: r.score,
      diversified: r.diversified,
    }));

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

    await c.env.CACHE.put(cacheKey, newRecsStr, { expirationTtl: 1800 });
    await c.env.CACHE.put(hashKey, newHash, { expirationTtl: 1800 });

    return c.json(enriched);
  } catch (e: unknown) {
    captureWorkerError(e as Error, { context: 'get-recommendations' });
    return handleError(c, e, 'Failed to get recommendations', 500);
  }
};
