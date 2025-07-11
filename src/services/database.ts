import { CONFIG } from '../config';
import type { Interaction, InteractionResult } from '../types';

export const checkUserExists = async (
  db: D1Database,
  userId: string
): Promise<boolean> => {
  const result = await db
    .prepare('SELECT 1 FROM interactions WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first();
  return !!result;
};

export const insertInteraction = async (
  db: D1Database,
  data: Omit<Interaction, 'weight'>
): Promise<void> => {
  const weight =
    CONFIG.ACTION_WEIGHTS[data.action as keyof typeof CONFIG.ACTION_WEIGHTS] ?? 0;
  await db
    .prepare(
      'INSERT INTO interactions (user_id, event_id, action, weight, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(data.user_id, data.event_id, data.action, weight, data.timestamp)
    .run();
};

export const getUserInteractions = async (
  db: D1Database,
  userId: string
): Promise<Omit<InteractionResult, 'total_weight' | 'latest'>[]> => {
  const result = await db
    .prepare(
      'SELECT event_id, action FROM interactions WHERE user_id = ? AND action != ?'
    )
    .bind(userId, 'signup')
    .all<Omit<InteractionResult, 'total_weight' | 'latest'>>();

  return result.results || [];
};

export const getUserInteractionCount = async (
  db: D1Database,
  userId: string
): Promise<number> => {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM interactions WHERE user_id = ?')
    .bind(userId)
    .first<{ count: number }>();

  return result?.count || 0;
};

export const getRecentEngagementRate = async (
  db: D1Database,
  userId: string
): Promise<number> => {
  const result = await db
    .prepare(
      `SELECT AVG(CASE WHEN action IN ('like', 'click') THEN 1 ELSE 0 END) as rate
       FROM interactions 
       WHERE user_id = ? AND timestamp > ?`
    )
    .bind(userId, Date.now() - 7 * 24 * 60 * 60 * 1000)
    .first<{ rate: number }>();

  return result?.rate || 0;
};

export const getUserDemographics = async (
  db: D1Database,
  userId: string
): Promise<{ country: string | null; interests: string[] } | null> => {
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

export const getSimilarUsers = async (
  db: D1Database,
  userId: string,
  limit = 5
): Promise<{ user_id: string; common_interactions: number }[]> => {
  const result = await db
    .prepare(
      `SELECT
        i2.user_id,
        COUNT(i1.event_id) as common_interactions
      FROM interactions i1
      JOIN interactions i2 ON i1.event_id = i2.event_id AND i1.user_id != i2.user_id
      WHERE i1.user_id = ? AND i1.action IN ('like', 'click')
      GROUP BY i2.user_id
      ORDER BY common_interactions DESC
      LIMIT ?`
    )
    .bind(userId, limit)
    .all<{ user_id: string; common_interactions: number }>();

  return result.results || [];
};

export const getSimilarUserInteractions = async (
  db: D1Database,
  userIds: string[]
): Promise<Omit<InteractionResult, 'total_weight' | 'latest'>[]> => {
  if (userIds.length === 0) return [];

  const placeholders = userIds.map(() => '?').join(',');
  const result = await db
    .prepare(
      `SELECT event_id, action FROM interactions
      WHERE user_id IN (${placeholders}) AND action IN ('like', 'click')
      ORDER BY timestamp DESC
      LIMIT 30`
    )
    .bind(...userIds)
    .all<Omit<InteractionResult, 'total_weight' | 'latest'>>();

  return result.results || [];
};
