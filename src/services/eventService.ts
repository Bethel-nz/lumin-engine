import type { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { EnvBindings } from '../types';
import type { IngestEvent } from '../validation/tinybird-schemas';
import * as schema from '../db/schema';
import { getOpenAIClient, getVectorIndex } from '../lib/clients';
import { getTinybirdClient, createEventIngestionEndpoint } from '../lib/tinybird';
import { generateEmbedding } from './vector';
import { withRetry } from '../utils';
import { createLogger, createMetricsCollector, withTiming } from './observability';
import { D1CompensationQueue, type CompensationAction } from './compensation';

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

  logger.info('Starting event ingestion', {
    requestId,
    eventId: eventData.id,
    writeToD1: options.writeToD1
  });

  const errors: string[] = [];
  let tinybirdResult: unknown;
  let success = false;

  try {
    const vectorIndex = getVectorIndex(c);
    const openai = getOpenAIClient(c);
    const tb = getTinybirdClient(c);
    const ingestEvent = createEventIngestionEndpoint(tb);
    const db = drizzle(c.env.DB, { schema });
    const compensationQueue = new D1CompensationQueue(c.env.DB, c.env);

    const embeddingText = `${eventData.title} ${eventData.description || ''} ${eventData.tags.join(' ')} ${eventData.host ? `hosted by ${eventData.host}` : ''}`;

    let vector: number[];
    let tbResult: unknown;
    let completedOperations: string[] = [];

    try {
      [vector, tbResult] = await Promise.all([
        withTiming(
          'embedding_generation',
          () => generateEmbedding(embeddingText, openai),
          metrics,
          { eventId: eventData.id }
        ),
        withTiming(
          'tinybird_ingestion',
          () => withRetry(() => ingestEvent({
            ...eventData,
            created_at: Date.now(),
            updated_at: Date.now(),
          })),
          metrics,
          { eventId: eventData.id }
        )
      ]);

      completedOperations.push('tinybird_ingest', 'embedding_generation');
      tinybirdResult = tbResult;

      if (vector.every((v) => v === 0)) {
        throw new Error('Failed to generate a valid embedding for the event.');
      }
    } catch (error) {
      const compensationAction: CompensationAction = {
        id: crypto.randomUUID(),
        type: 'manual_intervention',
        description: `Failed initial operations for event ${eventData.id}`,
        payload: {
          eventId: eventData.id,
          eventData,
          error: (error as Error).message,
          completedOperations
        },
        timestamp: Date.now(),
        status: 'pending'
      };
      await compensationQueue.enqueue(compensationAction);
      throw error;
    }

    try {
      await withTiming(
        'vector_upsert',
        () => vectorIndex.upsert([
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
        ]),
        metrics,
        { eventId: eventData.id }
      );

      completedOperations.push('vector_upsert');

      if (options.writeToD1) {
        await withTiming(
          'd1_insert',
          () => db.insert(schema.events).values({
            id: eventData.id,
            metadata: {
              title: eventData.title,
              host: eventData.host,
              category: eventData.category,
              location: eventData.location
            }
          }),
          metrics,
          { eventId: eventData.id }
        );

        completedOperations.push('d1_insert');
      }

      success = true;
      metrics.recordCounter('event_ingestion_success', 1, {
        writeToD1: options.writeToD1.toString()
      });

      logger.info('Event ingestion completed successfully', {
        requestId,
        eventId: eventData.id,
        writeToD1: options.writeToD1,
        completedOperations
      });

    } catch (error) {
      const failedOperation = completedOperations.includes('vector_upsert') ? 'd1_insert' : 'vector_upsert';

      const compensationAction: CompensationAction = {
        id: crypto.randomUUID(),
        type: 'rollback',
        description: `Partial failure in event ingestion for ${eventData.id}`,
        payload: {
          eventId: eventData.id,
          operations: completedOperations,
          failedOperation,
          eventData,
          vector,
          tinybirdResult
        },
        timestamp: Date.now(),
        status: 'pending',
        maxRetries: 3
      };

      await compensationQueue.enqueue(compensationAction);
      errors.push(`Partial failure: ${failedOperation} failed, compensation queued`);

      throw error;
    }

  } catch (error: unknown) {
    const err = error as Error;
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

    throw error;
  }

  return {
    tinybirdResult,
    eventId: eventData.id,
    success,
    errors: errors.length > 0 ? errors : undefined
  };
};