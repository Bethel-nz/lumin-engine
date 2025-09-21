import type { Index } from '@upstash/vector';
import type { Context } from 'hono';
import { CONFIG } from '../config';
import type {
  EnrichedRecommendation,
  EnvBindings,
  ExplorationItem,
} from '../types';
import { getRecentEngagementRate, getUserInteractionCount } from './database';
import {
  getTrendingItems as getAnalyticsTrending,
  getSerendipityItems as getAnalyticsSerendipity,
  getAntiCorrelatedRecommendations as getAnalyticsAntiCorrelated
} from './analytics';
import { withRetry } from '../utils';

export const getExplorationRate = async (
  userId: string,
  env: EnvBindings
): Promise<number> => {
  try {
    const interactionCount = await getUserInteractionCount(env.DB, userId);
    const recentEngagement = await getRecentEngagementRate(env.DB, userId);

    const baseRate = Math.max(
      CONFIG.EXPLORATION.MIN_RATE + 0.05, // Ensure always above minimum
      CONFIG.EXPLORATION.BASE_RATE - interactionCount * CONFIG.EXPLORATION.RATE_DECAY_PER_INTERACTION
    );

    if (recentEngagement < CONFIG.EXPLORATION.LOW_ENGAGEMENT_THRESHOLD) {
      return Math.min(CONFIG.EXPLORATION.MAX_RATE, Math.max(0.45, baseRate * CONFIG.EXPLORATION.LOW_ENGAGEMENT_MULTIPLIER));
    }

    return baseRate;
  } catch (error) {
    // Fallback to a safe default rate on error
    return CONFIG.EXPLORATION.BASE_RATE;
  }
};

export const getAntiCorrelatedRecommendations = async (
  userVector: number[],
  vectorIndex: Index,
  topK = 2
): Promise<ExplorationItem[]> => {
  return getAnalyticsAntiCorrelated(userVector, vectorIndex, topK);
};

export const getTrendingItems = async (
  c: Context<{ Bindings: EnvBindings }>,
  topK = 2
): Promise<ExplorationItem[]> => {
  return getAnalyticsTrending(c, topK);
};

export const getSerendipityItems = async (
  userId: string,
  vectorIndex: Index,
  c: Context<{ Bindings: EnvBindings }>,
  topK = 1
): Promise<ExplorationItem[]> => {
  return getAnalyticsSerendipity(userId, vectorIndex, c, topK);
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
