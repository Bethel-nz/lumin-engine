import { vi } from 'vitest';

// Mock Upstash Vector
vi.mock('@upstash/vector', () => {
  const mockIndex = {
    upsert: vi.fn().mockResolvedValue({ success: true }),
    query: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockResolvedValue([]),
  };
  return {
    Index: vi.fn(() => mockIndex),
  };
});

// Mock OpenAI
vi.mock('openai', () => {
  const mockOpenAI = {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [
          { embedding: new Array(1536).fill(0).map(() => Math.random()) },
        ],
      }),
    },
  };
  return {
    __esModule: true,
    default: vi.fn(() => mockOpenAI),
  };
});

// Mock Drizzle ORM for D1
vi.mock('drizzle-orm/d1', () => {
  const chainable = {
    values: vi.fn().mockResolvedValue({ success: true }),
  };

  const tx = {
    insert: vi.fn(() => chainable),
  };

  const db = {
    transaction: vi.fn().mockImplementation(async (callback) => callback(tx)),
    insert: vi.fn(() => chainable), // Ensure direct calls are also mocked
    query: {
      userProfiles: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      events: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      interactions: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  };

  return {
    drizzle: vi.fn().mockReturnValue(db),
  };
}); 