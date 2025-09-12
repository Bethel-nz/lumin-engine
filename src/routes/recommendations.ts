import type { Context } from 'hono';
import { getOpenAIClient, getVectorIndex } from '../lib/clients';
import {
  getExplorationRate,
  injectExploration,
  trackExplorationSuccess,
} from '../services/exploration';
import {
  getTrendingItems,
  getSerendipityItems,
  getAntiCorrelatedRecommendations,
} from '../services/analytics';
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
      const simplifiedResponse = recs.map((rec: any) => ({
        event_id: rec.event_id,
        score: rec.score,
        diversified: rec.diversified
      }));
      
      return c.json({
        recommendations: simplifiedResponse,
        metadata: {
          user_id: userId,
          ab_group: await getABTestGroup(userId, c.env.CACHE),
          exploration_rate: await getExplorationRate(userId, c.env),
          total_candidates: recs.length,
          cache_hit: true
        }
      });
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
    const initialTopK = 200;
    const useDiversification = abGroup === 'A';

    // Get hybrid user vector using all recommendation strategies
    const userVector = await computeHybridUserVector(
      userId,
      c.env,
      openai,
      vectorIndex
    );

    if (userVector.every((v) => v === 0)) {
      const trending = await getTrendingItems(c, 100);
      const trendingRecs = trending.map((item) => ({
        event_id: item.event_id,
        score: item.score,
        diversified: false,
      }));
      
      return c.json({
        recommendations: trendingRecs,
        metadata: {
          user_id: userId,
          ab_group: abGroup,
          exploration_rate: 0,
          total_candidates: trendingRecs.length,
          cache_hit: false,
          fallback: 'trending'
        }
      });
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
      return c.json({
        recommendations: [],
        metadata: {
          user_id: userId,
          ab_group: abGroup,
          exploration_rate: 0,
          total_candidates: 0,
          cache_hit: false
        }
      });
    }

    let finalRecs = filteredCandidates.map((r) => ({
      ...r,
      diversified: false,
    }));

    const candidateCount = finalRecs.length;
    
    if (useDiversification && candidateCount >= 20) {
      const mainCount = Math.floor(candidateCount * 0.8);
      const diverseCount = candidateCount - mainCount;
      
      const diverseSelection = finalRecs
        .slice(0, mainCount)
        .concat(finalRecs.slice(-diverseCount));
      
      finalRecs = diverseSelection.map((r, index) => ({
        ...r,
        diversified: index >= mainCount,
      }));
    }

    let enriched: EnrichedRecommendation[] = finalRecs.map((r) => ({
      event_id: r.id.toString(),
      score: r.score,
      diversified: r.diversified,
    }));

    const explorationRate = await getExplorationRate(userId, c.env);
    if (Math.random() < explorationRate) {
      const explorationCount = Math.max(3, Math.floor(candidateCount * 0.15));
      const itemsPerType = Math.ceil(explorationCount / 3);
      
      const explorationItems = await Promise.all([
        getAntiCorrelatedRecommendations(userVector, vectorIndex, itemsPerType),
        getSerendipityItems(userId, vectorIndex, c, itemsPerType),
        getTrendingItems(c, itemsPerType),
      ]);
      enriched = injectExploration(
        enriched,
        explorationItems.flat().slice(0, explorationCount),
        explorationRate
      );
    }

    await trackExplorationSuccess(userId, enriched, c.env);

    const newRecsStr = JSON.stringify(enriched);
    const newHash = generateHash(newRecsStr);

    await c.env.CACHE.put(cacheKey, newRecsStr, { expirationTtl: 1800 });
    await c.env.CACHE.put(hashKey, newHash, { expirationTtl: 1800 });

    const simplifiedResponse = enriched.map(rec => ({
      event_id: rec.event_id,
      score: rec.score,
      diversified: rec.diversified
    }));

    return c.json({
      recommendations: simplifiedResponse,
      metadata: {
        user_id: userId,
        ab_group: abGroup,
        exploration_rate: explorationRate,
        total_candidates: filteredCandidates.length,
        cache_hit: false
      }
    });
  } catch (e: unknown) {
    captureWorkerError(e as Error, { context: 'get-recommendations' });
    return handleError(c, e, 'Failed to get recommendations', 500);
  }
};
