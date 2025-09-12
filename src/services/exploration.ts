import type { Index } from '@upstash/vector';
import type { Context } from 'hono';
import { CONFIG } from '../config';
import type {
  EnrichedRecommendation,
  EnvBindings,
  ExplorationItem,
} from '../types';
import { getRecentEngagementRate, getUserInteractionCount } from './database';
import { getTrendingItems, getSerendipityItems, getAntiCorrelatedRecommendations } from './analytics';

export const getExplorationRate = async (
  userId: string,
  env: EnvBindings
): Promise<number> => {
  const interactionCount = await getUserInteractionCount(env.DB, userId);
  const recentEngagement = await getRecentEngagementRate(env.DB, userId);

  const baseRate = Math.max(
    CONFIG.EXPLORATION.BASE_RATE,
    0.4 - interactionCount * 0.01
  );

  if (recentEngagement < 0.3) {
    return Math.min(CONFIG.EXPLORATION.MAX_RATE, baseRate * 2);
  }

  return baseRate;
};

export const getAntiCorrelatedRecommendations = async (
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

export const getTrendingItems = async (
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
    .bind(Date.now() - 3 * 24 * 60 * 60 * 1000, topK)
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

export const getSerendipityItems = async (
  userId: string,
  vectorIndex: Index,
  env: EnvBindings,
  topK = 1
): Promise<ExplorationItem[]> => {
  const userTags = await env.CACHE.get(`user_tags:${userId}`);
  const avoidTags: string[] = userTags ? JSON.parse(userTags) : [];

  const randomVector = new Array(CONFIG.EMBEDDING.DIMENSIONS)
    .fill(0)
    .map(() => Math.random() - 0.5);

  const randomResults = await withRetry(() =>
    vectorIndex.query({
      vector: randomVector,
      topK: topK * 5,
      includeMetadata: true,
    })
  );

  const serendipitous = randomResults
    .filter((r) => {
      const metadata = r.metadata as VectorMetadata | undefined;
      if (!metadata?.tags) return true;
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

export const injectExploration = (
  mainRecs: EnrichedRecommendation[],
  explorationItems: ExplorationItem[],
  explorationRate: number
): EnrichedRecommendation[] => {
  if (explorationItems.length === 0) return mainRecs;

  const result = [...mainRecs];
  let expIndex = 0;

  for (const slot of CONFIG.EXPLORATION.INJECTION_SLOTS) {
    if (
      slot < result.length &&
      expIndex < explorationItems.length &&
      Math.random() < explorationRate
    ) {
      result.splice(slot, 0, {
        event_id: explorationItems[expIndex].event_id,
        score: explorationItems[expIndex].score,
        diversified: true,
      });
      expIndex++;
    }
  }

  return result;
};

export const trackExplorationSuccess = async (
  userId: string,
  recommendations: EnrichedRecommendation[],
  env: EnvBindings
): Promise<void> => {
  const explorationItems = recommendations
    .filter((r) => r.diversified)
    .map((r) => r.event_id);

  if (explorationItems.length > 0) {
    await env.CACHE.put(
      `exploration_tracking:${userId}:${Date.now()}`,
      JSON.stringify(explorationItems),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );
  }
};
