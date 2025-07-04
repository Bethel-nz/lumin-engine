import { Index } from '@upstash/vector';
import type { EnvBindings, VectorMetadata } from '../types';
import { captureWorkerError } from '../utils';
import { fetchEventVectors } from './vector';

export const updateSingleTagVector = async (
  tag: string,
  env: EnvBindings,
  vectorIndex: Index
): Promise<void> => {
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
    }, new Array(3072).fill(0))
    .map((v) => v / validEventVectors.length);

  const existingTagsStr = await env.TAG_VECTORS_KV.get('all_tags');
  const existingTags: Record<string, number[]> = existingTagsStr
    ? JSON.parse(existingTagsStr)
    : {};

  const currentTagVector = existingTags[tag] || new Array(3072).fill(0);

  const learningRate = 0.1;
  const updatedVector = currentTagVector.map(
    (val, i) => val * (1 - learningRate) + averageEventVector[i] * learningRate
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

    if (!recentEventsQuery.results || recentEventsQuery.results.length === 0) {
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
    });
  }
};
