import type { Context } from 'hono';
import type { EnvBindings } from '../types';
import { handleError, validateInput } from '../utils';
import { ingestEventSchema } from '../validation/tinybird-schemas';
import { processEventIngestion } from '../services/eventService';

export const ingestEventRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  try {
    const body = await c.req.json();
    const eventData = validateInput(body, ingestEventSchema);

    const { tinybirdResult } = await processEventIngestion(c, eventData, {
      writeToD1: true,
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
