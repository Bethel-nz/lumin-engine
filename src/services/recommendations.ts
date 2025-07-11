import type { Index } from '@upstash/vector';
import type OpenAI from 'openai';
import { CONFIG } from '../config';
import type { EnvBindings } from '../types';
import {
  getSimilarUserInteractions,
  getSimilarUsers,
  getUserDemographics,
  getUserInteractions,
} from './database';
import {
  buildInteractionVector,
  combineVectors,
  generateEmbedding,
} from './vector';

export const getCollaborativeVector = async (
  userId: string,
  env: EnvBindings,
  vectorIndex: Index
): Promise<number[]> => {
  const similarUsers = await getSimilarUsers(env.DB, userId, 5);

  if (similarUsers.length === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  const similarUserIds = similarUsers.map(
    (u: { user_id: string; common_interactions: number }) => u.user_id
  );
  const similarInteractions = await getSimilarUserInteractions(
    env.DB,
    similarUserIds
  );

  if (similarInteractions.length === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  return buildInteractionVector(similarInteractions, vectorIndex);
};

export const computeHybridUserVector = async (
  userId: string,
  env: EnvBindings,
  openai: OpenAI,
  vectorIndex: Index
): Promise<number[]> => {
  try {
    const interactions = await getUserInteractions(env.DB, userId);

    const cachedTags = await env.CACHE.get(`user_tags:${userId}`);
    const selectedTags: string[] = cachedTags ? JSON.parse(cachedTags) : [];

    const demographics = await getUserDemographics(env.DB, userId);
    const demographicsText =
      demographics && demographics.interests && demographics.interests.length > 0
        ? `${demographics.country} ${demographics.interests.join(' ')}`
        : demographics
        ? demographics.country
        : '';

    const [
      interactionVector,
      tagVector,
      collaborativeVector,
      demographicsVector,
    ] = await Promise.all([
      buildInteractionVector(interactions, vectorIndex),
      selectedTags.length
        ? generateEmbedding(selectedTags.join(' '), openai)
        : Promise.resolve(new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0)),
      getCollaborativeVector(userId, env, vectorIndex),
      demographicsText
        ? generateEmbedding(demographicsText, openai)
        : Promise.resolve(new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0)),
    ]);

    const finalVector = combineVectors([
      { vector: interactionVector, weight: 0.5 },
      { vector: tagVector, weight: 0.3 },
      { vector: collaborativeVector, weight: 0.2 },
      { vector: demographicsVector, weight: 0.1 },
    ]);

    return (
      finalVector ?? new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0)
    );
  } catch (error) {
    console.error('Error computing hybrid user vector:', error);
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }
};
