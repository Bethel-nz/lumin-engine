import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchRoute } from './search';
import * as vectorService from '../services/vector';
import * as client from '../lib/clients';

vi.mock('../services/vector', () => ({
  generateEmbedding: vi.fn(),
}));

const mockVectorIndex = {
  query: vi.fn(),
};

vi.mock('../lib/clients', () => ({
  getVectorIndex: vi.fn(() => mockVectorIndex),
  getOpenAIClient: vi.fn(),
}));

const mockContext = (query: string | null) =>
  ({
    req: {
      query: vi.fn().mockReturnValue({ query }),
    },
    json: vi.fn((data) => new Response(JSON.stringify(data))),
    env: {},
  }) as any;

describe('searchRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return search results for a valid query', async () => {
    const query = 'tech conference';
    const context = mockContext(query);

    (vectorService.generateEmbedding as any).mockResolvedValue(
      new Array(1536).fill(0.5)
    );

    mockVectorIndex.query.mockResolvedValue([
      {
        id: 'evt_123',
        score: 0.95,
        metadata: { title: 'Tech Conference 2025', tags: ['tech'] },
      },
    ]);

    const response = await searchRoute(context);
    const data = (await response.json()) as {
      results: { event_id: string; title: string }[];
    };

    expect(response.status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].event_id).toBe('evt_123');
    expect(data.results[0].title).toBe('Tech Conference 2025');
  });

  it('should return a 400 error if query parameter is missing', async () => {
    const context = mockContext(null);
    const response = await searchRoute(context);
    expect(response.status).toBe(400);
  });

  it('should return a 500 error if embedding generation fails', async () => {
    const query = 'some query that will fail';
    const context = mockContext(query);

    // Mock an embedding failure by returning a zero-vector
    (vectorService.generateEmbedding as any).mockResolvedValue(
      new Array(1536).fill(0)
    );

    const response = await searchRoute(context);
    expect(response.status).toBe(400);

    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Failed to perform search');
  });
}); 