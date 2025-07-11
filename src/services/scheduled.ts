import { Index } from '@upstash/vector';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { OpenAI } from 'openai';
import { CONFIG } from '../config';
import * as schema from '../db/schema';
import type { EnvBindings } from '../types';
import { captureWorkerError } from '../utils';
import { computeHybridUserVector } from './recommendations';
import { fetchEventVectors } from './vector';

export const updateSingleTagVector = async (
  tag: string,
  eventIds: string[],
  env: EnvBindings,
  vectorIndex: Index
): Promise<void> => {
  const eventVectorsData = await fetchEventVectors(vectorIndex, eventIds);
  const validEventVectors: number[][] = [];

  for (const vectorData of Object.values(eventVectorsData)) {
    if (vectorData?.vector && Array.isArray(vectorData.vector)) {
      validEventVectors.push(vectorData.vector);
    }
  }

  if (validEventVectors.length === 0) {
    return;
  }

  const averageEventVector = validEventVectors
    .reduce((acc, vec) => {
      return acc.map((val, i) => val + (vec[i] ?? 0));
    }, new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0))
    .map((v) => v / validEventVectors.length);

  const existingTagsStr = await env.TAG_VECTORS_KV.get('all_tags');
  const existingTags: Record<string, number[]> = existingTagsStr
    ? JSON.parse(existingTagsStr)
    : {};

  const currentTagVector =
    existingTags[tag] || new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);

  const learningRate = 0.1;
  const updatedVector = currentTagVector.map(
    (val, i) =>
      val * (1 - learningRate) + (averageEventVector[i] ?? 0) * learningRate
  );

  existingTags[tag] = updatedVector;

  await env.TAG_VECTORS_KV.put('all_tags', JSON.stringify(existingTags));
};

export const scheduledTagVectorUpdate = async (
  env: EnvBindings,
  ctx: ExecutionContext
): Promise<void> => {
  try {
    const vectorIndex = new Index({
      url: env.VECTOR_URL,
      token: env.VECTOR_TOKEN,
    });
    const db = drizzle(env.DB, { schema });

    const timeWindowMs = 24 * 60 * 60 * 1000;
    const cutoffTimestamp = new Date(Date.now() - timeWindowMs).toISOString();

    const recentInteractions = await db.query.interactions.findMany({
      where: (interactions, { gte, inArray }) =>
        gte(interactions.timestamp, cutoffTimestamp) &&
        inArray(interactions.action, ['like', 'click', 'view']),
      columns: {
        eventId: true,
      },
      limit: 500,
    });

    if (!recentInteractions || recentInteractions.length === 0) {
      return;
    }

    const recentEventIds = [
      ...new Set(recentInteractions.map((i) => i.eventId)),
    ];

    const eventsWithTags = await db.query.events.findMany({
      where: inArray(schema.events.id, recentEventIds),
      with: {
        tags: {
          columns: {
            tag: true,
          },
        },
      },
    });

    const activeTags = new Map<string, string[]>();
    for (const event of eventsWithTags) {
      for (const tag of event.tags) {
        if (!activeTags.has(tag.tag)) {
          activeTags.set(tag.tag, []);
        }
        activeTags.get(tag.tag)?.push(event.id);
      }
    }

    if (activeTags.size === 0) {
      return;
    }

    for (const [tag, eventIds] of activeTags.entries()) {
      ctx.waitUntil(updateSingleTagVector(tag, eventIds, env, vectorIndex));
    }
  } catch (error) {
    captureWorkerError(error as Error, {
      context: 'scheduled-tag-vector-update',
    });
  }
};

export const scheduledRecommendationUpdate = async (
  env: EnvBindings,
  ctx: ExecutionContext
): Promise<void> => {
  try {
    const db = drizzle(env.DB, { schema });
    const vectorIndex = new Index({
      url: env.VECTOR_URL,
      token: env.VECTOR_TOKEN,
    });
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    // Get recently active users
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const activeUsers = await db.query.userProfiles.findMany({
      where: (userProfiles, { gte }) =>
        gte(userProfiles.lastActiveAt, twoDaysAgo),
      limit: 100, // Limit to avoid excessive processing
    });

    for (const user of activeUsers) {
      ctx.waitUntil(
        (async () => {
          try {
            const userVector = await computeHybridUserVector(
              user.userId,
              env,
              openai,
              vectorIndex
            );

            if (userVector.every((v: number) => v === 0)) {
              return; // Skip if no user vector could be generated
            }

            const recommendations = await vectorIndex.query({
              vector: userVector,
              topK: 20,
              includeMetadata: true,
            });

            // Cache the recommendations
            await env.CACHE.put(
              `recs:${user.userId}`,
              JSON.stringify(recommendations),
              { expirationTtl: 1800 } // 30 minutes
            );
          } catch (error) {
            captureWorkerError(error as Error, {
              context: 'scheduled-recommendation-update',
              userId: user.userId,
            });
          }
        })()
      );
    }
  } catch (error) {
    captureWorkerError(error as Error, {
      context: 'scheduled-recommendation-update',
    });
  }
};
