import type { EnvBindings } from '../types';
import { createLogger } from './observability';

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
    const result = await this.db
      .prepare(`
        SELECT * FROM compensation_queue
        WHERE status = 'pending'
        AND (retry_count < max_retries OR max_retries IS NULL)
        ORDER BY timestamp ASC
        LIMIT 1
      `)
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

  async markCompleted(actionId: string): Promise<void> {
    await this.db
      .prepare('UPDATE compensation_queue SET status = ? WHERE id = ?')
      .bind('completed', actionId)
      .run();

    this.logger.info('Compensation action completed', { actionId });
  }

  async markFailed(actionId: string, error: string): Promise<void> {
    await this.db
      .prepare(`
        UPDATE compensation_queue
        SET status = ?, retry_count = retry_count + 1, error = ?
        WHERE id = ?
      `)
      .bind('failed', error, actionId)
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
      const err = error as Error;
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

    if (operations.includes('vector_store')) {
      // TODO: Implement vector store deletion
      this.logger.warn('Vector store rollback not implemented', { eventId });
    }

    if (operations.includes('d1_database')) {
      // TODO: Implement D1 deletion
      this.logger.warn('D1 database rollback not implemented', { eventId });
    }
  }

  private async executeRetry(action: CompensationAction): Promise<void> {
    const { eventId, operation, data } = action.payload as {
      eventId: string;
      operation: string;
      data: unknown;
    };

    this.logger.info('Executing retry', {
      actionId: action.id,
      eventId,
      operation
    });

    switch (operation) {
      case 'tinybird_ingest':
        // TODO: Re-attempt Tinybird ingestion with provided data
        break;
      case 'vector_upsert':
        // TODO: Re-attempt vector upsert with provided data
        break;
      case 'd1_insert':
        // TODO: Re-attempt D1 insert with provided data
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

  async startProcessingLoop(intervalMs = 30000): Promise<void> {
    const processLoop = async (): Promise<void> => {
      try {
        let processed = false;
        do {
          processed = await this.processNext();
        } while (processed);
      } catch (error) {
        this.logger.error('Error in compensation processing loop', error as Error);
      }
    };

    setInterval(processLoop, intervalMs);
    this.logger.info('Compensation processing loop started', { intervalMs });
  }
}