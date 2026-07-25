import type { Context } from 'hono';
import type { EnvBindings } from '../types';
import { handleError } from '../utils';
import { ingestEventSchema } from '../validation/tinybird-schemas';
import { processEventIngestion } from '../services/eventService';

export const ingestEventRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  try {
    const body = await c.req.json();
    const eventData = ingestEventSchema.parse(body);

    const { eventId, tinybirdResult } = await processEventIngestion(c, eventData, {
      writeToD1: true,
    });

    return c.json({
      success: true,
      event_id: eventId,
      message: `Event "${eventData.title}" ingested.`,
      tinybird_response: tinybirdResult
    }, 201);
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to ingest event');
  }
};
