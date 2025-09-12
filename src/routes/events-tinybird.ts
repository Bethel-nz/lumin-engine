import type { Context } from 'hono';
import { getOpenAIClient, getVectorIndex } from '../lib/clients';
import { getTinybirdClient, createEventIngestionEndpoint } from '../lib/tinybird';
import { generateEmbedding } from '../services/vector';
import type { EnvBindings } from '../types';
import { handleError, validateInput, withRetry } from '../utils';
import { ingestEventSchema } from '../validation/tinybird-schemas';

export const ingestEventTinybirdRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  try {
    const body = await c.req.json();
    const eventData = validateInput(body, ingestEventSchema);

    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);
    const tb = getTinybirdClient(c);
    const ingestEvent = createEventIngestionEndpoint(tb);

    const embeddingText = `${eventData.title} ${eventData.description || ''} ${eventData.tags.join(' ')} ${eventData.host ? `hosted by ${eventData.host}` : ''}`;
    
    const [vector, tinybirdResult] = await Promise.all([
      generateEmbedding(embeddingText, openai),
      withRetry(() => ingestEvent({
        ...eventData,
        created_at: Date.now(),
        updated_at: Date.now(),
      }))
    ]);

    if (vector.every((v) => v === 0)) {
      throw new Error('Failed to generate a valid embedding for the event.');
    }

    await withRetry(async () => {
      await vectorIndex.upsert([
        { 
          id: eventData.id, 
          vector, 
          metadata: { 
            title: eventData.title, 
            tags: eventData.tags, 
            host: eventData.host ?? '',
            category: eventData.category ?? '',
            location: eventData.location ?? ''
          } 
        },
      ]);
    });

    return c.json({ 
      success: true, 
      message: `Event ${eventData.id} ingested.`,
      tinybird_response: tinybirdResult 
    }, 201);
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to ingest event');
  }
};