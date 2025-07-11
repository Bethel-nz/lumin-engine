// In: src/routes/recommendations.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRecommendationsRoute } from './recommendations';
import { getVectorIndex } from '../lib/clients';
import type { EnrichedRecommendation } from '../types';

// --- MOCK THE DIRECT DEPENDENCIES of getRecommendationsRoute ---

// Mock the entire recommendations service to control computeHybridUserVector
vi.mock('../services/recommendations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/recommendations')>();
  return {
    ...actual,
    computeHybridUserVector: vi.fn(),
  };
});

// Mock the exploration service to control getTrendingItems
vi.mock('../services/exploration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/exploration')>();
  return {
    ...actual,
    getTrendingItems: vi.fn(),
    getExplorationRate: vi.fn().mockResolvedValue(0), // Default to no exploration
    injectExploration: vi.fn((recs) => recs), // Default to pass-through
    trackExplorationSuccess: vi.fn(),
  };
});

// Mock the clients lib (if not already handled by context)
vi.mock('../lib/clients', () => ({
  getVectorIndex: vi.fn().mockReturnValue({ query: vi.fn() }), // Return a dummy index
  getOpenAIClient: vi.fn(),
}));

// Mock the utils (specifically for getABTestGroup)
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    getABTestGroup: vi.fn().mockResolvedValue('B'), // Return a default group
    generateHash: vi.fn().mockReturnValue('new_hash'),
  };
});

// --- Import the mocked services AFTER setting up the mocks ---
import * as recommendationsService from '../services/recommendations';
import * as explorationService from '../services/exploration';
import * as utils from '../utils';

// --- Test Setup ---

const mockCache = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn(),
};

const mockEnv = {
  DB: {},
  CACHE: mockCache,
} as any;

const mockContext = (userId: string) =>
  ({
    req: {
      param: vi.fn().mockReturnValue(userId), // FIX: Return the string directly
    },
    env: mockEnv,
    json: vi.fn((data) => new Response(JSON.stringify(data), { status: 200 })),
  }) as any;

// --- Helper Functions for Mocks ---
const mockVectorQuery = (results: any[]) => {
  (getVectorIndex as any).mockReturnValue({ query: vi.fn().mockResolvedValue(results) });
};

// --- The Test Suite ---

describe('getRecommendationsRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCache.get.mockResolvedValue(null);
    mockCache.put.mockClear();
    vi.mocked(utils.getABTestGroup).mockResolvedValue('B');
  });

  it('should return trending items for a cold start user', async () => {
    const userId = 'new_user_123';
    const context = mockContext(userId);

    const mockedComputeVector = recommendationsService.computeHybridUserVector as any;
    mockedComputeVector.mockResolvedValue(new Array(1536).fill(0));

    const mockedGetTrending = explorationService.getTrendingItems as any;
    const popularItems = [
      { event_id: 'evt_popular_1', score: 0.9 },
      { event_id: 'evt_popular_2', score: 0.8 },
    ];
    mockedGetTrending.mockResolvedValue(popularItems);

    const response = await getRecommendationsRoute(context);
    const data = (await response.json()) as { event_id: string }[];

    expect(response.status).toBe(200);
    expect(data).toHaveLength(2);
    expect(data[0].event_id).toBe('evt_popular_1');
    expect(recommendationsService.computeHybridUserVector).toHaveBeenCalled();
    expect(explorationService.getTrendingItems).toHaveBeenCalled();
    expect(mockCache.put).not.toHaveBeenCalled();
  });

  it('should return personalized recommendations for a user with history', async () => {
    const userId = 'user_with_history';
    const context = mockContext(userId);

    const mockedComputeVector = recommendationsService.computeHybridUserVector as any;
    const userVector = new Array(1536).fill(0).map((_, i) => i * 0.001);
    mockedComputeVector.mockResolvedValue(userVector);

    const vectorResults = [
      { id: 'evt_rec_1', score: 0.95, metadata: { name: 'Event 1' } },
      { id: 'evt_rec_2', score: 0.92, metadata: { name: 'Event 2' } },
    ];
    mockVectorQuery(vectorResults);

    const response = await getRecommendationsRoute(context);
    const data = (await response.json()) as { event_id: string }[];

    expect(response.status).toBe(200);
    expect(data).toHaveLength(2);
    expect(data[0].event_id).toBe('evt_rec_1');
    expect(getVectorIndex(context.env).query).toHaveBeenCalledWith(
      expect.objectContaining({ vector: userVector, topK: 50 })
    );
    expect(mockCache.put).toHaveBeenCalledTimes(2);
  });

  it('should return cached recommendations if available', async () => {
    const userId = 'cached_user';
    const context = mockContext(userId);
    const cachedRecs = [{ event_id: 'evt_cached_1', score: 0.99 }];

    mockCache.get.mockResolvedValueOnce(JSON.stringify(cachedRecs));

    const response = await getRecommendationsRoute(context);
    const data = (await response.json()) as { event_id: string }[];

    expect(response.status).toBe(200);
    expect(data).toEqual(cachedRecs);
    expect(mockCache.get).toHaveBeenCalledTimes(1);
    expect(recommendationsService.computeHybridUserVector).not.toHaveBeenCalled();
    expect(getVectorIndex(context.env).query).not.toHaveBeenCalled();
    expect(mockCache.put).not.toHaveBeenCalled();
  });

  it('should apply diversification for users in AB test group A', async () => {
    const userId = 'user_in_group_a';
    const context = mockContext(userId);

    vi.mocked(utils.getABTestGroup).mockResolvedValue('A');

    const mockedComputeVector = recommendationsService.computeHybridUserVector as any;
    mockedComputeVector.mockResolvedValue(new Array(1536).fill(0.1));

    const vectorResults = Array.from({ length: 20 }, (_, i) => ({
      id: `evt_a_${i}`,
      score: 0.9 - i * 0.01,
      metadata: {},
    }));
    mockVectorQuery(vectorResults);

    const response = await getRecommendationsRoute(context);
    const data = (await response.json()) as { event_id: string; diversified: boolean }[];

    expect(response.status).toBe(200);
    expect(data).toHaveLength(10);
    expect(data.filter((d) => d.diversified)).toHaveLength(2);
    expect(data[9].event_id).toBe('evt_a_19');
    expect(getVectorIndex(context.env).query).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 40 })
    );
  });

  it('should filter recommendations based on user tags', async () => {
    const userId = 'user_with_tags';
    const context = mockContext(userId);

    const userTags = ['rock', 'pop'];
    // The first `get` is for the main recommendations cache, which we want to miss.
    // The second `get` is for the user tags.
    mockCache.get
      .mockResolvedValueOnce(null) // for recs
      .mockResolvedValueOnce(JSON.stringify(userTags)); // for user_tags

    const mockedComputeVector = recommendationsService.computeHybridUserVector as any;
    mockedComputeVector.mockResolvedValue(new Array(1536).fill(0.1));

    const vectorResults = [
      { id: 'evt_tagged_1', score: 0.95, metadata: { tags: ['rock'] } },
      { id: 'evt_untagged_1', score: 0.94, metadata: { tags: ['jazz'] } },
      { id: 'evt_tagged_2', score: 0.93, metadata: { tags: ['pop', 'live'] } },
      { id: 'evt_untagged_2', score: 0.92, metadata: { tags: ['classical'] } },
    ];
    mockVectorQuery(vectorResults);

    const response = await getRecommendationsRoute(context);
    const data = (await response.json()) as { event_id: string }[];

    expect(response.status).toBe(200);
    expect(data).toHaveLength(2);
    expect(data.map((d) => d.event_id)).toEqual(['evt_tagged_1', 'evt_tagged_2']);
  });

  it('should return an empty array if no candidates remain after filtering', async () => {
    const userId = 'user_with_unmatched_tags';
    const context = mockContext(userId);

    const userTags = ['metal'];
    mockCache.get
      .mockResolvedValueOnce(null) // for recs
      .mockResolvedValueOnce(JSON.stringify(userTags)); // for user_tags

    const mockedComputeVector = recommendationsService.computeHybridUserVector as any;
    mockedComputeVector.mockResolvedValue(new Array(1536).fill(0.1));

    const vectorResults = [
      { id: 'evt_untagged_1', score: 0.94, metadata: { tags: ['jazz'] } },
      { id: 'evt_untagged_2', score: 0.92, metadata: { tags: ['classical'] } },
    ];
    mockVectorQuery(vectorResults);

    const response = await getRecommendationsRoute(context);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual([]);
    expect(mockCache.put).not.toHaveBeenCalled();
  });

  it('should inject exploration items when exploration rate is high', async () => {
    const userId = 'exploratory_user';
    const context = mockContext(userId);

    const mockedExploration = explorationService as any;
    mockedExploration.getExplorationRate.mockResolvedValue(1.0);

    const mockedComputeVector = recommendationsService.computeHybridUserVector as any;
    mockedComputeVector.mockResolvedValue(new Array(1536).fill(0.1));
    const vectorResults = [
      { id: 'evt_rec_1', score: 0.95, metadata: {} },
      { id: 'evt_rec_2', score: 0.92, metadata: {} },
    ];
    mockVectorQuery(vectorResults);

    const explorationItems = [{ event_id: 'evt_explore_1', score: 0.5, diversified: false, id: 'evt_explore_1' }];
    mockedExploration.injectExploration.mockImplementation((recs: EnrichedRecommendation[]) => [...recs, ...explorationItems]);

    // Mock the chained calls for exploration items
    mockedExploration.getAntiCorrelatedRecommendations = vi.fn().mockResolvedValue([]);
    mockedExploration.getSerendipityItems = vi.fn().mockResolvedValue(explorationItems);
    mockedExploration.getTrendingItems = vi.fn().mockResolvedValue([]);


    const response = await getRecommendationsRoute(context);
    const data = (await response.json()) as { event_id: string }[];

    expect(response.status).toBe(200);
    expect(data.length).toBe(3);
    expect(data.map((d) => d.event_id)).toContain('evt_explore_1');
    expect(explorationService.getExplorationRate).toHaveBeenCalledWith(userId, context.env);
    expect(explorationService.injectExploration).toHaveBeenCalled();
    expect(mockCache.put).toHaveBeenCalledTimes(2);
  });
}); 