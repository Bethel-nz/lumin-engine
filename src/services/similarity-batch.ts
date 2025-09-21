import type { EnvBindings } from '../types';
import { createLogger, createMetricsCollector, withTiming } from './observability';

export interface UserSimilarity {
  user_id: string;
  similar_user_id: string;
  similarity_score: number;
  common_interactions: number;
  last_updated: number;
}

export interface SimilarityBatchJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  user_batch_start: string;
  user_batch_end: string;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  processed_users: number;
  total_similarities: number;
  error?: string;
}

export class SimilarityPrecomputer {
  private db: D1Database;
  private env: EnvBindings;
  private logger;
  private metrics;
  private batchSize = 1000;
  private similarityThreshold = 2; // Minimum common interactions

  constructor(db: D1Database, env: EnvBindings) {
    this.db = db;
    this.env = env;
    this.logger = createLogger(env);
    this.metrics = createMetricsCollector(env);
  }

  async createSimilarityBatchJobs(): Promise<string[]> {
    const activeUsers = await this.db
      .prepare(`
        SELECT DISTINCT user_id
        FROM interactions
        WHERE timestamp > ?
        ORDER BY user_id
      `)
      .bind(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
      .all<{ user_id: string }>();

    const users = (activeUsers.results || []).map(r => r.user_id);
    const jobIds: string[] = [];

    for (let i = 0; i < users.length; i += this.batchSize) {
      const batchStart = users[i];
      const batchEnd = users[Math.min(i + this.batchSize - 1, users.length - 1)];
      const jobId = crypto.randomUUID();

      await this.db
        .prepare(`
          INSERT INTO similarity_batch_jobs
          (id, status, user_batch_start, user_batch_end, created_at, processed_users, total_similarities)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(jobId, 'pending', batchStart, batchEnd, Date.now(), 0, 0)
        .run();

      jobIds.push(jobId);
    }

    this.logger.info('Created similarity batch jobs', {
      totalJobs: jobIds.length,
      totalUsers: users.length,
      batchSize: this.batchSize
    });

    return jobIds;
  }

  async processBatchJob(jobId: string): Promise<void> {
    const job = await this.db
      .prepare('SELECT * FROM similarity_batch_jobs WHERE id = ?')
      .bind(jobId)
      .first<SimilarityBatchJob>();

    if (!job || job.status !== 'pending') {
      throw new Error(`Job ${jobId} not found or not pending`);
    }

    await this.db
      .prepare('UPDATE similarity_batch_jobs SET status = ?, started_at = ? WHERE id = ?')
      .bind('running', Date.now(), jobId)
      .run();

    this.logger.info('Starting similarity batch job', {
      jobId,
      userBatchStart: job.user_batch_start,
      userBatchEnd: job.user_batch_end
    });

    try {
      const result = await withTiming(
        'similarity_batch_processing',
        () => this.computeSimilaritiesForBatch(job),
        this.metrics,
        { jobId }
      );

      await this.db
        .prepare(`
          UPDATE similarity_batch_jobs
          SET status = ?, completed_at = ?, processed_users = ?, total_similarities = ?
          WHERE id = ?
        `)
        .bind('completed', Date.now(), result.processedUsers, result.totalSimilarities, jobId)
        .run();

      this.logger.info('Completed similarity batch job', {
        jobId,
        processedUsers: result.processedUsers,
        totalSimilarities: result.totalSimilarities
      });

    } catch (error) {
      const err = error as Error;
      await this.db
        .prepare('UPDATE similarity_batch_jobs SET status = ?, error = ? WHERE id = ?')
        .bind('failed', err.message, jobId)
        .run();

      this.logger.error('Failed similarity batch job', err, { jobId });
      throw error;
    }
  }

  private async computeSimilaritiesForBatch(job: SimilarityBatchJob): Promise<{
    processedUsers: number;
    totalSimilarities: number;
  }> {
    // Get users in this batch with their interactions
    const batchUsers = await this.db
      .prepare(`
        SELECT DISTINCT user_id
        FROM interactions
        WHERE user_id >= ? AND user_id <= ?
        AND action IN ('like', 'click')
        ORDER BY user_id
      `)
      .bind(job.user_batch_start, job.user_batch_end)
      .all<{ user_id: string }>();

    const users = (batchUsers.results || []).map(r => r.user_id);
    let processedUsers = 0;
    let totalSimilarities = 0;

    // Process similarities for each user in the batch
    for (const userId of users) {
      const similarities = await this.computeUserSimilarities(userId);

      if (similarities.length > 0) {
        await this.storeSimilarities(userId, similarities);
        totalSimilarities += similarities.length;
      }

      processedUsers++;

      if (processedUsers % 10 === 0) {
        this.logger.debug('Batch progress', {
          jobId: job.id,
          processedUsers,
          totalUsers: users.length,
          totalSimilarities
        });
      }
    }

    return { processedUsers, totalSimilarities };
  }

  private async computeUserSimilarities(userId: string): Promise<UserSimilarity[]> {
    // Use optimized query with better indexing strategy
    const similarities = await this.db
      .prepare(`
        WITH user_events AS (
          SELECT DISTINCT event_id
          FROM interactions
          WHERE user_id = ? AND action IN ('like', 'click')
        ),
        similar_users AS (
          SELECT
            i.user_id,
            COUNT(DISTINCT i.event_id) as common_interactions,
            COUNT(DISTINCT ui.event_id) as user_total_events
          FROM interactions i
          INNER JOIN user_events ue ON i.event_id = ue.event_id
          CROSS JOIN (
            SELECT COUNT(DISTINCT event_id) as total_events
            FROM user_events
          ) ui
          WHERE i.user_id != ?
          AND i.action IN ('like', 'click')
          GROUP BY i.user_id
          HAVING common_interactions >= ?
        )
        SELECT
          user_id as similar_user_id,
          common_interactions,
          CAST(common_interactions AS FLOAT) / CAST(user_total_events AS FLOAT) as similarity_score
        FROM similar_users
        ORDER BY similarity_score DESC, common_interactions DESC
        LIMIT 20
      `)
      .bind(userId, userId, this.similarityThreshold)
      .all<{
        similar_user_id: string;
        common_interactions: number;
        similarity_score: number;
      }>();

    return (similarities.results || []).map(row => ({
      user_id: userId,
      similar_user_id: row.similar_user_id,
      similarity_score: row.similarity_score,
      common_interactions: row.common_interactions,
      last_updated: Date.now()
    }));
  }

  private async storeSimilarities(userId: string, similarities: UserSimilarity[]): Promise<void> {
    // Clear existing similarities for this user
    await this.db
      .prepare('DELETE FROM user_similarities WHERE user_id = ?')
      .bind(userId)
      .run();

    // Insert new similarities in batches
    const batchSize = 50;
    for (let i = 0; i < similarities.length; i += batchSize) {
      const batch = similarities.slice(i, i + batchSize);
      const values = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = batch.flatMap(s => [
        s.user_id,
        s.similar_user_id,
        s.similarity_score,
        s.common_interactions,
        s.last_updated
      ]);

      await this.db
        .prepare(`
          INSERT INTO user_similarities
          (user_id, similar_user_id, similarity_score, common_interactions, last_updated)
          VALUES ${values}
        `)
        .bind(...params)
        .run();
    }
  }

  async getPrecomputedSimilarUsers(
    userId: string,
    limit = 5
  ): Promise<{ user_id: string; common_interactions: number; similarity_score: number }[]> {
    const result = await this.db
      .prepare(`
        SELECT similar_user_id as user_id, common_interactions, similarity_score
        FROM user_similarities
        WHERE user_id = ?
        ORDER BY similarity_score DESC, common_interactions DESC
        LIMIT ?
      `)
      .bind(userId, limit)
      .all<{ user_id: string; common_interactions: number; similarity_score: number }>();

    return result.results || [];
  }

  async cleanupOldSimilarities(olderThanDays = 7): Promise<number> {
    const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.db
      .prepare('DELETE FROM user_similarities WHERE last_updated < ?')
      .bind(cutoffTime)
      .run();

    this.logger.info('Cleaned up old similarities', {
      deletedRows: result.changes,
      olderThanDays
    });

    return result.changes || 0;
  }

  async scheduleRegularRecomputation(): Promise<void> {
    // Schedule recomputation every 6 hours
    const recomputeInterval = 6 * 60 * 60 * 1000;

    const runRecomputation = async (): Promise<void> => {
      try {
        this.logger.info('Starting scheduled similarity recomputation');
        const jobIds = await this.createSimilarityBatchJobs();

        // Process jobs sequentially to avoid overwhelming the database
        for (const jobId of jobIds) {
          await this.processBatchJob(jobId);
        }

        await this.cleanupOldSimilarities();
        this.logger.info('Completed scheduled similarity recomputation', {
          processedJobs: jobIds.length
        });

      } catch (error) {
        this.logger.error('Failed scheduled similarity recomputation', error as Error);
      }
    };

    setInterval(runRecomputation, recomputeInterval);
    this.logger.info('Scheduled regular similarity recomputation', {
      intervalHours: 6
    });
  }
}