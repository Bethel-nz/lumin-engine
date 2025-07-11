import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import * as schema from '../db/schema';
import { getOpenAIClient, getVectorIndex } from '../lib/clients';
import { generateEmbedding } from '../services/vector';
import type { EnvBindings } from '../types';
import { handleError, validateInput, withRetry } from '../utils';
import { ingestEventSchema } from '../validation/schemas';

export const ingestEventRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  try {
    const body = await c.req.json();
    const { id, title, tags, host } = validateInput(body, ingestEventSchema);

    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);
    const db = drizzle(c.env.DB, { schema });

    const embeddingText = `${title} ${tags.join(' ')} ${host ? `hosted by ${host}` : ''}`;
    const vector = await generateEmbedding(embeddingText, openai);

    if (vector.every((v) => v === 0)) {
      throw new Error('Failed to generate a valid embedding for the event.');
    }

    await withRetry(async () => {
      // First, complete the database transaction
      await db.transaction(async (tx) => {
        await tx
          .insert(schema.events)
          .values({ id, metadata: { title, host } });

        if (tags && tags.length > 0) {
          await tx
            .insert(schema.eventTags)
            .values(tags.map((tag) => ({ eventId: id, tag })));
        }
      });

      // Then, upsert to vector index
      await vectorIndex.upsert([
        { id, vector, metadata: { title, tags, host: host ?? '' } },
      ]);
    });
    return c.json({ success: true, message: `Event ${id} ingested.` }, 201);
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to ingest event');
  }
};
