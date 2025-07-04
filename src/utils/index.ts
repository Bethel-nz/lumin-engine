import { hashSync } from 'bcrypt-edge';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ABTestGroup } from '../types';

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> => {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      return await fn();
    } catch (e: unknown) {
      const error = e as Error;
      attempts++;
      if (
        attempts === maxRetries ||
        (!error.message.includes('network') &&
          !error.message.includes('timeout') &&
          !(
            error instanceof Error &&
            'status' in error &&
            error.status === 500
          ) &&
          !(e instanceof Error && e.message.includes('fetch failed')))
      ) {
        throw error;
      }
      const maxDelay = baseDelayMs * 2 ** attempts;
      const jitteredDelay = Math.floor(Math.random() * maxDelay);
      await delay(jitteredDelay);
    }
  }
  throw new Error('Max retries reached');
};

export const generateHash = (data: string): string => {
  return hashSync(data, 8);
};

export const captureWorkerError = <T>(
  error: Error,
  context?: Record<string, T>
): void => {
  console.error(`Worker Error: ${error.message}`, {
    error: error.stack,
    ...context,
  });

  // TODO: Send to monitoring service (e.g., Sentry, Datadog, etc.)
  // This could be implemented with fetch to external monitoring APIs
};

const hashCode = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

export const getABTestGroup = async (
  userId: string,
  cache: KVNamespace
): Promise<ABTestGroup> => {
  const cacheKey = `ab_group:${userId}`;
  const cachedGroup = await cache.get(cacheKey);
  if (cachedGroup === 'A' || cachedGroup === 'B') {
    return cachedGroup;
  }
  const group = hashCode(userId) % 2 === 0 ? 'A' : 'B';
  await cache.put(cacheKey, group, { expirationTtl: 2592000 });
  return group;
};

export const validateInput = <T>(data: unknown, schema: z.ZodSchema<T>): T => {
  return schema.parse(data);
};

export const handleError = (
  _c: Context,
  error: unknown,
  message = 'Bad Request',
  status = 400
): Response => {
  let responseBody: object;
  let responseStatus = status;

  if (error instanceof z.ZodError) {
    responseBody = { error: 'Validation failed', details: error.errors };
    responseStatus = 400;
  } else {
    responseBody = {
      error: message,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  return new Response(JSON.stringify(responseBody), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  });
};
