import type { Context } from 'hono';
import type { EnvBindings } from '../types';
import type { IngestEvent } from '../validation/tinybird-schemas';
import { getEmbeddingClient, getVectorIndex } from '../lib/clients';
import { getTinybirdClient, createEventIngestionEndpoint } from '../lib/tinybird';
import { generateMultimodalEmbedding } from './vector';
import { withRetry } from '../utils';
import { createLogger, createMetricsCollector, withTiming } from './observability';
import { D1CompensationQueue, type CompensationAction } from './compensation';
import { persistEventToD1, upsertEventVector } from './event-storage';

interface IngestionOptions {
  writeToD1: boolean;
}

interface IngestionResult {
  tinybirdResult: unknown;
  eventId: string;
  success: boolean;
  errors?: string[];
}

export const processEventIngestion = async (
  c: Context<{ Bindings: EnvBindings }>,
  eventData: IngestEvent,
  options: IngestionOptions
): Promise<IngestionResult> => {
  const logger = createLogger(c.env);
  const metrics = createMetricsCollector(c.env);
  const requestId = crypto.randomUUID();
  const eventId = eventData.id;

  logger.info('Starting event ingestion', {
    requestId,
    eventId,
    writeToD1: options.writeToD1
  });

  const errors: string[] = [];
  let tinybirdResult: unknown;
  let success = false;

  try {
    const vectorIndex = getVectorIndex(c);
    const embeddingClient = getEmbeddingClient(c);
    const tb = getTinybirdClient(c);
    const ingestEvent = createEventIngestionEndpoint(tb);
    const compensationQueue = new D1CompensationQueue(c.env.DB, c.env);

    const embeddingText = `${eventData.title} ${eventData.description || ''} ${eventData.tags.join(' ')} ${eventData.host ? `hosted by ${eventData.host}` : ''}`;

    let vector: number[];
    const completedOperations: string[] = [];

    const [embeddingOutcome, tinybirdOutcome] = await Promise.allSettled([
      withTiming(
        'embedding_generation',
        () =>
          generateMultimodalEmbedding(
            embeddingText,
            eventData.image_url,
            embeddingClient
          ),
        metrics,
        { eventId }
      ),
      withTiming(
        'tinybird_ingestion',
        () => withRetry(() => ingestEvent(eventData)),
        metrics,
        { eventId }
      ),
    ]);

    if (tinybirdOutcome.status === 'fulfilled') {
      tinybirdResult = tinybirdOutcome.value;
      completedOperations.push('tinybird_ingest');
    } else {
      const compensationAction: CompensationAction = {
        id: crypto.randomUUID(),
        type: 'retry',
        description: `Retry Tinybird ingestion for event ${eventId}`,
        payload: {
          eventId,
          operation: 'tinybird_ingest',
          eventData,
        },
        timestamp: Date.now(),
        status: 'pending',
        maxRetries: 5,
      };
      await compensationQueue.enqueue(compensationAction);
      errors.push('Tinybird ingestion queued for retry');
    }

    if (embeddingOutcome.status === 'rejected') {
      const embeddingError =
        embeddingOutcome.reason instanceof Error
          ? embeddingOutcome.reason
          : new Error(String(embeddingOutcome.reason));
      const compensationAction: CompensationAction = {
        id: crypto.randomUUID(),
        type: 'retry',
        description: `Retry embedding and persistence for event ${eventId}`,
        payload: {
          eventId,
          operation: 'embedding_and_vector',
          eventData,
          writeToD1: options.writeToD1,
          error: embeddingError.message,
        },
        timestamp: Date.now(),
        status: 'pending',
        maxRetries: 5,
      };
      await compensationQueue.enqueue(compensationAction);
      throw embeddingError;
    }

    vector = embeddingOutcome.value;
    completedOperations.push('embedding_generation');

    if (vector.every((v) => v === 0)) {
      await compensationQueue.enqueue({
        id: crypto.randomUUID(),
        type: 'retry',
        description: `Retry embedding and persistence for event ${eventId}`,
        payload: {
          eventId,
          operation: 'embedding_and_vector',
          eventData,
          writeToD1: options.writeToD1,
        },
        timestamp: Date.now(),
        status: 'pending',
        maxRetries: 5,
      });
      throw new Error('Failed to generate a valid embedding for the event.');
    }

    try {
      await withTiming(
        'vector_upsert',
        () => upsertEventVector(vectorIndex, eventData, vector),
        metrics,
        { eventId }
      );

      completedOperations.push('vector_upsert');

      if (options.writeToD1) {
        await withTiming(
          'd1_insert',
          () => persistEventToD1(c.env.DB, eventData),
          metrics,
          { eventId }
        );

        completedOperations.push('d1_insert');
      }

      success = true;
      metrics.recordCounter('event_ingestion_success', 1, {
        writeToD1: options.writeToD1.toString()
      });

      logger.info('Event ingestion completed successfully', {
        requestId,
        eventId,
        writeToD1: options.writeToD1,
        completedOperations
      });

    } catch (error) {
      const failedOperation = completedOperations.includes('vector_upsert') ? 'd1_insert' : 'vector_upsert';

      const compensationAction: CompensationAction = {
        id: crypto.randomUUID(),
        type: 'retry',
        description: `Retry ${failedOperation} for event ${eventId}`,
        payload: {
          eventId,
          operation: failedOperation,
          eventData,
          vector,
          writeToD1: options.writeToD1,
        },
        timestamp: Date.now(),
        status: 'pending',
        maxRetries: 5,
      };

      await compensationQueue.enqueue(compensationAction);
      errors.push(`${failedOperation} failed and was queued for retry`);

      throw error;
    }

  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    errors.push(err.message);

    metrics.recordCounter('event_ingestion_error', 1, {
      writeToD1: options.writeToD1.toString(),
      errorType: err.name || 'Unknown'
    });

    logger.error('Event ingestion failed', err, {
      requestId,
      eventId: eventData.id,
      writeToD1: options.writeToD1
    });

    if (errors.length > 0) {
      logger.warn('Partial ingestion failure detected', {
        requestId,
        eventId: eventData.id,
        errors: errors.length,
        errorMessages: errors
      });
    }

    throw err;
  }

  return {
    tinybirdResult,
    eventId: eventData.id,
    success,
    errors: errors.length > 0 ? errors : undefined
  };
};
