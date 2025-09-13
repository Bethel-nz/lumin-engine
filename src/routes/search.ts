import type { Context } from 'hono';
import { getOpenAIClient, getVectorIndex } from '../lib/clients';
import { generateEmbedding } from '../services/vector';
import type { EnvBindings, VectorMetadata } from '../types';
import { handleError, withRetry } from '../utils';

export const searchRoute = async (c: Context<{ Bindings: EnvBindings }>) => {
  const { query } = c.req.query();
  if (!query || query.trim() === '') {
    return handleError(c, null, 'Query parameter is required', 400);
  }

  try {
    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);

    const queryVector = await generateEmbedding(query, openai);
    if (queryVector.every((v) => v === 0)) {
      return handleError(c, null, 'Failed to perform search', 400);
    }

    const searchResults = await withRetry(() =>
      vectorIndex.query({
        vector: queryVector,
        topK: 20,
        includeMetadata: true,
      })
    );

    const results = searchResults.map((r) => {
      const metadata = r.metadata as VectorMetadata | undefined;
      return {
        event_id: r.id,
        title: metadata?.title ?? '',
        tags: metadata?.tags ?? [],
        score: r.score,
      };
    });

    return c.json({ results });
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to perform search');
  }
};
