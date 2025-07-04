import type { Index, Vector } from '@upstash/vector';
import type OpenAI from 'openai';
import { CONFIG } from '../config';
import type { EnvBindings, InteractionResult, VectorMetadata } from '../types';
import { captureWorkerError, withRetry } from '../utils';

export const generateEmbedding = async (
  text: string,
  openai: OpenAI
): Promise<number[]> => {
  if (!text?.trim()) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }
  try {
    const { data } = await withRetry(() =>
      openai.embeddings.create({
        model: CONFIG.EMBEDDING.MODEL,
        input: text.trim(),
      })
    );
    return data[0]?.embedding ?? new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  } catch (error) {
    captureWorkerError(error as Error, { context: 'generateEmbedding', text });
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }
};

export const fetchEventVectors = async (
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

export const buildInteractionVector = async (
  interactions: Omit<InteractionResult, 'total_weight' | 'latest'>[],
  vectorIndex: Index,
  openai: OpenAI
): Promise<number[]> => {
  if (!interactions.length)
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);

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
    : new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
};

export const combineVectors = (
  vectors: { vector: number[]; weight: number }[]
): number[] => {
  const totalWeight = vectors.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight === 0) return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);

  const finalVector = new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);

  for (const { vector, weight } of vectors) {
    if (vector.length === CONFIG.EMBEDDING.DIMENSIONS) {
      for (let i = 0; i < CONFIG.EMBEDDING.DIMENSIONS; i++) {
        finalVector[i] += vector[i] * (weight / totalWeight);
      }
    }
  }
  return finalVector;
};

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
  const validEventVectors = Object.values(eventVectorsData)
    .filter((v): v is Vector & { vector: number[] } => !!v?.vector)
    .map((v) => v.vector);

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
    (val, i) => val * (1 - learningRate) + averageEventVector[i] * learningRate
  );

  existingTags[tag] = updatedVector;

  await env.TAG_VECTORS_KV.put('all_tags', JSON.stringify(existingTags));
};
