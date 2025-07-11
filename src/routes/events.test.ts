
import { ingestEventRoute } from './events';
import { getVectorIndex } from '../lib/clients';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, test, vi,it } from 'vitest';

const mockEnv = {
  DB: {},
  CACHE: {},
  VECTOR_URL: 'test-vector-url',
  VECTOR_TOKEN: 'test-vector-token',
  OPENAI_API_KEY: 'test-openai-key',
} as any;

const mockContext = (body: any) => ({
  req: {
    json: vi.fn().mockResolvedValue(body),
  },
  env: mockEnv,
  json: vi.fn((data) => new Response(JSON.stringify(data))),
}) as any;

describe('ingestEventRoute', () => {
  let vectorIndex: any;
  let db: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vectorIndex = getVectorIndex({ env: mockEnv } as any);
    db = drizzle(mockEnv.DB);
  });

  it('should ingest an event successfully', async () => {
    const event = {
      id: 'evt_123',
      title: 'Tech Conference 2025',
      tags: ['tech', 'conference'],
      host: 'Synaxis',
    };
    const context = mockContext(event);

    await ingestEventRoute(context);

    expect(context.json).toHaveBeenCalledWith(
      { success: true, message: `Event ${event.id} ingested.` },
      201
    );

    expect(db.transaction).toHaveBeenCalled();
    expect(vectorIndex.upsert).toHaveBeenCalled();

    // Verify the transaction callback was called with correct data
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));

    // Verify vector upsert was called with event data
    expect(vectorIndex.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.id,
        metadata: expect.objectContaining({
          title: event.title,
          tags: event.tags,
          host: event.host
        })
      })
    );
  });
  it('should return a 400 error for invalid input', async () => {
    const event = {
      // Missing title, tags, etc.
      id: 'evt_123',
    };
    const context = mockContext(event);

    const response = await ingestEventRoute(context);

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data?.error).toBe('Validation failed');
  });
}); 