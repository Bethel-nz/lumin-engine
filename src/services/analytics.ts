import type { Index } from '@upstash/vector';
import { getTinybirdClient, createTrendingEventsQuery, createUserBehaviorQuery, createRealtimeTrendingQuery, createLocationTrendsQuery } from '../lib/tinybird';
import type { EnvBindings, ExplorationItem } from '../types';
import type { Context } from 'hono';

export const getTrendingItems = async (
  c: Context<{ Bindings: EnvBindings }>,
  limit: number = 50
): Promise<ExplorationItem[]> => {
  try {
    const tb = getTinybirdClient(c);
    const getTrending = createTrendingEventsQuery(tb);
    
    const results = await getTrending({
      hours: 24,
      limit,
    });

    return results.data.map(item => ({
      event_id: item.event_id,
      score: item.engagement_rate,
      exploration_type: 'trending' as const,
      confidence: Math.min(item.interaction_count / 100, 1),
    }));
  } catch (error) {
    console.error('Error fetching trending items from TinyBird:', error);
    return [];
  }
};

export const getRealtimeTrending = async (
  c: Context<{ Bindings: EnvBindings }>,
  minutes: number = 60,
  limit: number = 25
): Promise<ExplorationItem[]> => {
  try {
    const tb = getTinybirdClient(c);
    const getRealtimeTrending = createRealtimeTrendingQuery(tb);
    
    const results = await getRealtimeTrending({
      minutes,
      limit,
    });

    return results.data.map(item => ({
      event_id: item.event_id,
      score: item.engagement_score,
      exploration_type: 'trending' as const,
      confidence: Math.min(item.interaction_velocity / 10, 1),
    }));
  } catch (error) {
    console.error('Error fetching realtime trending from TinyBird:', error);
    return [];
  }
};

export const getUserBehaviorProfile = async (
  c: Context<{ Bindings: EnvBindings }>,
  userId: string,
  days: number = 30
) => {
  try {
    const tb = getTinybirdClient(c);
    const getUserBehavior = createUserBehaviorQuery(tb);
    
    const result = await getUserBehavior({
      user_id: userId,
      days,
    });

    return result.data[0] || null;
  } catch (error) {
    console.error('Error fetching user behavior from TinyBird:', error);
    return null;
  }
};

export const getLocationBasedTrending = async (
  c: Context<{ Bindings: EnvBindings }>,
  location: string,
  days: number = 7,
  limit: number = 10
): Promise<ExplorationItem[]> => {
  try {
    const tb = getTinybirdClient(c);
    const getLocationTrends = createLocationTrendsQuery(tb);
    
    const results = await getLocationTrends({
      location,
      days,
      limit,
    });

    return results.data.map(item => ({
      event_id: item.event_id,
      score: item.engagement_rate,
      exploration_type: 'trending' as const,
      confidence: Math.min(item.interaction_count / 50, 1),
    }));
  } catch (error) {
    console.error('Error fetching location trends from TinyBird:', error);
    return [];
  }
};

export const getCategoryBasedTrending = async (
  c: Context<{ Bindings: EnvBindings }>,
  category: string,
  hours: number = 24,
  limit: number = 10
): Promise<ExplorationItem[]> => {
  try {
    const tb = getTinybirdClient(c);
    const getTrending = createTrendingEventsQuery(tb);
    
    const results = await getTrending({
      category,
      hours,
      limit,
    });

    return results.data.map(item => ({
      event_id: item.event_id,
      score: item.engagement_rate,
      exploration_type: 'trending' as const,
      confidence: Math.min(item.interaction_count / 30, 1),
    }));
  } catch (error) {
    console.error('Error fetching category trends from TinyBird:', error);
    return [];
  }
};

export const getSerendipityItems = async (
  userId: string,
  vectorIndex: Index,
  c: Context<{ Bindings: EnvBindings }>,
  limit: number = 5
): Promise<ExplorationItem[]> => {
  try {
    const userBehavior = await getUserBehaviorProfile(c, userId, 7);
    if (!userBehavior) return [];

    const uncommonCategories = userBehavior.preferred_categories
      .filter((_, index) => index > 2);

    if (uncommonCategories.length === 0) return [];

    const randomCategory = uncommonCategories[
      Math.floor(Math.random() * uncommonCategories.length)
    ];

    const categoryTrending = await getCategoryBasedTrending(
      c,
      randomCategory,
      168,
      limit
    );

    return categoryTrending.map(item => ({
      ...item,
      exploration_type: 'serendipity' as const,
      confidence: item.confidence * 0.7,
    }));
  } catch (error) {
    console.error('Error generating serendipity items:', error);
    return [];
  }
};

export const getAntiCorrelatedRecommendations = async (
  userVector: number[],
  vectorIndex: Index,
  limit: number = 3
): Promise<ExplorationItem[]> => {
  try {
    const invertedVector = userVector.map(v => -v);
    
    const results = await vectorIndex.query({
      vector: invertedVector,
      topK: limit * 2,
      includeMetadata: true,
    });

    return results.slice(0, limit).map(result => ({
      event_id: result.id.toString(),
      score: result.score,
      exploration_type: 'anti_correlated' as const,
      confidence: Math.max(0.3, 1 - result.score),
    }));
  } catch (error) {
    console.error('Error getting anti-correlated recommendations:', error);
    return [];
  }
};