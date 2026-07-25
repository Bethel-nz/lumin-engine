import { Index } from '@upstash/vector';
import type { EnvBindings } from '../types';
import { ingestEventSchema } from '../validation/tinybird-schemas';
import {
  createEventIngestionEndpoint,
  getTinybirdClientFromEnv,
} from '../lib/tinybird';
import { createLogger } from './observability';
import { persistEventToD1, upsertEventVector } from './event-storage';
import { generateMultimodalEmbedding } from './vector';
import { createEmbeddingClient } from './embedding';

export interface CompensationAction {
  id: string;
  type: 'rollback' | 'retry' | 'manual_intervention';
  description: string;
  payload: Record<string, unknown>;
  timestamp: number;
  status: 'pending' | 'completed' | 'failed';
  retryCount?: number;
  maxRetries?: number;
}

export interface CompensationQueue {
  enqueue(action: CompensationAction): Promise<void>;
  dequeue(): Promise<CompensationAction | null>;
  markCompleted(actionId: string): Promise<void>;
  markFailed(actionId: string, error: string): Promise<void>;
  getFailedActions(): Promise<CompensationAction[]>;
}

export class D1CompensationQueue implements CompensationQueue {
  private db: D1Database;
  private env: EnvBindings;
  private logger;

  constructor(db: D1Database, env: EnvBindings) {
    this.db = db;
    this.env = env;
    this.logger = createLogger(env);
  }

  async enqueue(action: CompensationAction): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO compensation_queue
        (id, type, description, payload, timestamp, status, retry_count, max_retries)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        action.id,
        action.type,
        action.description,
        JSON.stringify(action.payload),
        action.timestamp,
        action.status,
        action.retryCount || 0,
        action.maxRetries || 3
      )
      .run();

    this.logger.info('Compensation action queued', {
      actionId: action.id,
      type: action.type,
      description: action.description
    });
  }

  async dequeue(): Promise<CompensationAction | null> {
    const now = Date.now();
    const staleClaim = now - 5 * 60 * 1000;

    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.db
        .prepare(`
          SELECT * FROM compensation_queue
          WHERE status = 'pending'
          AND (retry_count < max_retries OR max_retries IS NULL)
          AND (claimed_at IS NULL OR claimed_at < ?)
          ORDER BY timestamp ASC
          LIMIT 1
        `)
        .bind(staleClaim)
        .first<{
          id: string;
          type: string;
          description: string;
          payload: string;
          timestamp: number;
          status: string;
          retry_count: number;
          max_retries: number;
        }>();

      if (!result) return null;

      const claim = await this.db
        .prepare(`
          UPDATE compensation_queue
          SET claimed_at = ?
          WHERE id = ?
          AND status = 'pending'
          AND (claimed_at IS NULL OR claimed_at < ?)
        `)
        .bind(now, result.id, staleClaim)
        .run();

      if (claim.meta.changes === 0) continue;

      return {
        id: result.id,
        type: result.type as CompensationAction['type'],
        description: result.description,
        payload: JSON.parse(result.payload),
        timestamp: result.timestamp,
        status: result.status as CompensationAction['status'],
        retryCount: result.retry_count,
        maxRetries: result.max_retries,
      };
    }

    return null;
  }

  async markCompleted(actionId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE compensation_queue
         SET status = ?, claimed_at = NULL, error = NULL
         WHERE id = ?`
      )
      .bind('completed', actionId)
      .run();

    this.logger.info('Compensation action completed', { actionId });
  }

  async markFailed(actionId: string, error: string): Promise<void> {
    await this.db
      .prepare(`
        UPDATE compensation_queue
        SET
          retry_count = retry_count + 1,
          status = CASE
            WHEN retry_count + 1 >= COALESCE(max_retries, 3)
              THEN 'failed'
            ELSE 'pending'
          END,
          claimed_at = NULL,
          error = ?
        WHERE id = ?
      `)
      .bind(error, actionId)
      .run();

    this.logger.error('Compensation action failed', new Error(error), { actionId });
  }

  async getFailedActions(): Promise<CompensationAction[]> {
    const results = await this.db
      .prepare(`
        SELECT * FROM compensation_queue
        WHERE status = 'failed'
        AND retry_count >= max_retries
      `)
      .all<{
        id: string;
        type: string;
        description: string;
        payload: string;
        timestamp: number;
        status: string;
        retry_count: number;
        max_retries: number;
      }>();

    return (results.results || []).map(result => ({
      id: result.id,
      type: result.type as CompensationAction['type'],
      description: result.description,
      payload: JSON.parse(result.payload),
      timestamp: result.timestamp,
      status: result.status as CompensationAction['status'],
      retryCount: result.retry_count,
      maxRetries: result.max_retries,
    }));
  }
}

export class CompensationProcessor {
  private queue: CompensationQueue;
  private env: EnvBindings;
  private logger;

  constructor(queue: CompensationQueue, env: EnvBindings) {
    this.queue = queue;
    this.env = env;
    this.logger = createLogger(env);
  }

  async processNext(): Promise<boolean> {
    const action = await this.queue.dequeue();
    if (!action) return false;

    this.logger.info('Processing compensation action', {
      actionId: action.id,
      type: action.type,
      retryCount: action.retryCount
    });

    try {
      switch (action.type) {
        case 'rollback':
          await this.executeRollback(action);
          break;
        case 'retry':
          await this.executeRetry(action);
          break;
        case 'manual_intervention':
          await this.flagForManualIntervention(action);
          break;
        default:
          throw new Error(`Unknown compensation action type: ${action.type}`);
      }

      await this.queue.markCompleted(action.id);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.queue.markFailed(action.id, err.message);
      return true;
    }
  }

  private async executeRollback(action: CompensationAction): Promise<void> {
    const { eventId, operations } = action.payload as {
      eventId: string;
      operations: string[];
    };

    this.logger.info('Executing rollback', {
      actionId: action.id,
      eventId,
      operations
    });

    if (
      operations.includes('vector_store') ||
      operations.includes('vector_upsert')
    ) {
      const vectorIndex = new Index({
        url: this.env.VECTOR_URL,
        token: this.env.VECTOR_TOKEN,
      });
      await vectorIndex.delete(eventId);
    }

    if (
      operations.includes('d1_database') ||
      operations.includes('d1_insert')
    ) {
      await this.env.DB
        .prepare('DELETE FROM events WHERE id = ?')
        .bind(eventId)
        .run();
    }
  }

  private async executeRetry(action: CompensationAction): Promise<void> {
    const { eventId, operation, vector } = action.payload as {
      eventId: string;
      operation: string;
      vector?: number[];
    };
    const eventData = ingestEventSchema.parse(
      action.payload.eventData ?? action.payload.data
    );

    this.logger.info('Executing retry', {
      actionId: action.id,
      eventId,
      operation
    });

    switch (operation) {
      case 'embedding_and_vector': {
        const embeddingClient = createEmbeddingClient(this.env);
        const embeddingText = [
          eventData.title,
          eventData.description ?? '',
          eventData.tags.join(' '),
          eventData.host ? `hosted by ${eventData.host}` : '',
        ].join(' ');
        const regeneratedVector = await generateMultimodalEmbedding(
          embeddingText,
          eventData.image_url,
          embeddingClient
        );

        if (regeneratedVector.every((value) => value === 0)) {
          throw new Error('Embedding regeneration returned an empty vector');
        }

        const vectorIndex = new Index({
          url: this.env.VECTOR_URL,
          token: this.env.VECTOR_TOKEN,
        });
        await upsertEventVector(vectorIndex, eventData, regeneratedVector);
        if (action.payload.writeToD1 === true) {
          await persistEventToD1(this.env.DB, eventData);
        }
        break;
      }
      case 'tinybird_ingest': {
        const tinybird = getTinybirdClientFromEnv(this.env);
        const ingestEvent = createEventIngestionEndpoint(tinybird);
        await ingestEvent(eventData);
        break;
      }
      case 'vector_upsert': {
        if (!vector || vector.length === 0) {
          throw new Error('Missing vector for vector_upsert compensation');
        }
        const vectorIndex = new Index({
          url: this.env.VECTOR_URL,
          token: this.env.VECTOR_TOKEN,
        });
        await upsertEventVector(vectorIndex, eventData, vector);
        if (action.payload.writeToD1 === true) {
          await persistEventToD1(this.env.DB, eventData);
        }
        break;
      }
      case 'd1_insert':
        await persistEventToD1(this.env.DB, eventData);
        break;
      default:
        throw new Error(`Unknown retry operation: ${operation}`);
    }
  }

  private async flagForManualIntervention(action: CompensationAction): Promise<void> {
    this.logger.critical('Manual intervention required', undefined, {
      actionId: action.id,
      description: action.description,
      payload: action.payload
    });

    if (this.env.ALERTS_WEBHOOK) {
      await fetch(this.env.ALERTS_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: 'Manual intervention required',
          actionId: action.id,
          description: action.description,
          timestamp: new Date().toISOString(),
        })
      }).catch(err => {
        this.logger.error('Failed to send alert', err);
      });
    }
  }

  async processBatch(limit = 25): Promise<number> {
    let processedCount = 0;

    while (processedCount < limit) {
      const processed = await this.processNext();
      if (!processed) break;
      processedCount++;
    }

    this.logger.info('Compensation batch processed', { processedCount, limit });
    return processedCount;
  }
}

export const processCompensationQueue = async (
  env: EnvBindings,
  limit = 25
): Promise<number> => {
  const queue = new D1CompensationQueue(env.DB, env);
  const processor = new CompensationProcessor(queue, env);
  return processor.processBatch(limit);
};
