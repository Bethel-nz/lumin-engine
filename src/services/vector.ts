import type { Index, Vector } from '@upstash/vector';
import { CONFIG } from '../config';
import type { InteractionResult } from '../types';
import { captureWorkerError, withRetry } from '../utils';
import {
  fetchImagePart,
  type EmbeddingClient,
  type EmbeddingPart,
  type EmbeddingTask,
} from './embedding';

const zeroVector = () => new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);

export const generateEmbedding = async (
  text: string,
  client: EmbeddingClient,
  taskType: EmbeddingTask = 'RETRIEVAL_DOCUMENT'
): Promise<number[]> => {
  if (!text?.trim()) {
    return zeroVector();
  }
  try {
    return await withRetry(() =>
      client.embed([{ text: text.trim() }], taskType)
    );
  } catch (error) {
    captureWorkerError(error as Error, { context: 'generateEmbedding', text });
    return zeroVector();
  }
};

export const generateMultimodalEmbedding = async (
  text: string,
  imageUrl: string | undefined | null,
  client: EmbeddingClient,
  taskType: EmbeddingTask = 'RETRIEVAL_DOCUMENT'
): Promise<number[]> => {
  const trimmed = text?.trim() ?? '';

  if (!imageUrl) {
    return generateEmbedding(trimmed, client, taskType);
  }

  try {
    const imagePart = await fetchImagePart(imageUrl);

    if (!imagePart) {
      captureWorkerError(new Error('Image unavailable for embedding'), {
        context: 'generateMultimodalEmbedding',
        imageUrl,
      });
      return generateEmbedding(trimmed, client, taskType);
    }

    const parts: EmbeddingPart[] = trimmed
      ? [{ text: trimmed }, imagePart]
      : [imagePart];

    return await withRetry(() => client.embed(parts, taskType));
  } catch (error) {
    captureWorkerError(error as Error, {
      context: 'generateMultimodalEmbedding',
      imageUrl,
    });
    return generateEmbedding(trimmed, client, taskType);
  }
};

export const fetchEventVectors = async (
  vectorIndex: Index,
  eventIds: string[]
): Promise<Record<string, Vector | null>> => {
  if (!eventIds || eventIds.length === 0) {
    return {};
  }
  const vectors = await withRetry(() =>
    vectorIndex.fetch(eventIds, { includeVectors: true })
  );
  const result: Record<string, Vector | null> = {};
  eventIds.forEach((id, index) => {
    result[id] = vectors[index];
  });
  return result;
};

export const buildInteractionVector = async (
  interactions: Omit<InteractionResult, 'total_weight' | 'latest'>[],
  vectorIndex: Index
): Promise<number[]> => {
  if (!interactions.length) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  const eventIds = [...new Set(interactions.map((r) => r.event_id))];
  const eventVectors = await fetchEventVectors(vectorIndex, eventIds);

  const weightedVector = new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  let totalWeight = 0;

  for (const interaction of interactions) {
    const vectorData = eventVectors[interaction.event_id];
    if (vectorData?.vector) {
      const vector = vectorData.vector as number[];

      // Time-decaying weight
      const interactionTime = new Date(interaction.timestamp).getTime();
      const now = Date.now();
      const ageInDays = (now - interactionTime) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.exp(-0.1 * ageInDays); // Exponential decay

      // Action weight
      const actionWeight =
        CONFIG.ACTION_WEIGHTS[
          interaction.action as keyof typeof CONFIG.ACTION_WEIGHTS
        ] ?? 0;
      const finalWeight = actionWeight * decayFactor;

      for (let i = 0; i < vector.length; i++) {
        weightedVector[i] += vector[i] * finalWeight;
      }
      totalWeight += finalWeight;
    }
  }

  if (totalWeight === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  // Normalize the aggregated vector
  const norm = Math.sqrt(
    weightedVector.reduce((sum, val) => sum + val * val, 0)
  );
  if (norm === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  return weightedVector.map((v) => v / norm);
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

  // Normalize the final combined vector
  const norm = Math.sqrt(finalVector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) {
    return new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
  }

  return finalVector.map((v) => v / norm);
};
