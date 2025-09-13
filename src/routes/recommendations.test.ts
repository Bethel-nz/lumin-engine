import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { getRecommendationsRoute } from './recommendations';
import * as clients from '../lib/clients';
import * as recommendationsService from '../services/recommendations';
import * as explorationService from '../services/exploration';
import * as analytics from '../services/analytics';
import * as utils from '../utils';
import type { EnvBindings, ExplorationItem } from '../types';

// Mock external dependencies that integrate with multiple systems
vi.mock('../lib/clients');
vi.mock('../services/recommendations');
vi.mock('../services/exploration');
vi.mock('../services/analytics');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    getABTestGroup: vi.fn().mockResolvedValue('B'),
    generateHash: vi.fn().mockReturnValue('test_hash'),
    withRetry: vi.fn((fn) => fn()),
    captureWorkerError: vi.fn(),
    handleError: vi.fn(), // Mock error handler as a spy
  };
});

/**
 * Recommendation Engine Tests with Dynamic Limits and TinyBird Analytics
 * 
 * These tests verify the new architecture where:
 * 1. No artificial limits - returns all relevant recommendations
 * 2. TinyBird powers trending and exploration features
 * 3. Dynamic diversification based on available candidates
 * 4. Structured response format for main server filtering
 * 
 * The key insight is that we're testing a recommendation orchestration system
 * that coordinates multiple data sources and applies intelligent filtering,
 * not just a simple similarity search.
 */
describe('getRecommendationsRoute - Dynamic Limits & TinyBird Integration', () => {
  const mockContext = {
    req: {
      param: vi.fn(),
    },
    json: vi.fn(),
    env: {
      CACHE: {
        get: vi.fn(),
        put: vi.fn(),
      },
    } as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  const mockVectorIndex = {
    query: vi.fn(),
  };
  const mockOpenAI = {} as any;

  beforeEach(() => {
    vi.resetAllMocks();

    // Reset individual mock functions that were cleared by resetAllMocks
    mockVectorIndex.query.mockResolvedValue([]);
    mockContext.env.CACHE.get.mockResolvedValue(null);
    mockContext.env.CACHE.put.mockResolvedValue();
    mockContext.req.param.mockReturnValue('test-user');
    mockContext.json.mockReturnValue({});

    // Reset utility mocks
    vi.mocked(utils.getABTestGroup).mockResolvedValue('B');
    vi.mocked(utils.generateHash).mockReturnValue('test_hash');
    vi.mocked(utils.withRetry).mockImplementation((fn) => fn());

    // Reset service mocks
    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue([]);
    vi.mocked(explorationService.getExplorationRate).mockResolvedValue(0.3);
    vi.mocked(explorationService.injectExploration).mockImplementation((recs) => recs);
    vi.mocked(explorationService.trackExplorationSuccess).mockResolvedValue();

    // Reset analytics mocks
    vi.mocked(analytics.getAntiCorrelatedRecommendations).mockResolvedValue([]);
    vi.mocked(analytics.getSerendipityItems).mockResolvedValue([]);
    vi.mocked(analytics.getTrendingItems).mockResolvedValue([]);

    // Setup successful default responses
    vi.mocked(clients.getVectorIndex).mockReturnValue(mockVectorIndex);
    vi.mocked(clients.getOpenAIClient).mockReturnValue(mockOpenAI);
  });

  /**
   * Dynamic Recommendation Limits: No artificial constraints
   * 
   * This test verifies that the system returns all relevant recommendations
   * without arbitrary limits, allowing the main server to decide pagination/filtering.
   * The new architecture fetches 200 candidates and returns all that match user preferences.
   */
  it('should return all relevant recommendations without artificial limits', async () => {
    const userId = 'user-unlimited';
    mockContext.req.param.mockReturnValue(userId);

    // Mock a large set of relevant recommendations (simulating rich data)
    const largeCandidateSet = Array.from({ length: 150 }, (_, i) => ({
      id: `event-${i}`,
      score: 0.9 - (i * 0.005), // Gradually decreasing scores
      metadata: {
        tags: ['tech', 'ai'],
        title: `Event ${i}`,
        host: 'TechCorp',
        category: 'technology',
        location: 'SF'
      }
    }));

    const mockUserVector = Array.from({ length: 1536 }, () => Math.random());
    
    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue(mockUserVector);
    mockVectorIndex.query.mockResolvedValue(largeCandidateSet);
    vi.mocked(explorationService.getExplorationRate).mockResolvedValue(0.3);
    vi.mocked(explorationService.trackExplorationSuccess).mockResolvedValue();

    // Mock user has selected tags for filtering
    mockContext.env.CACHE.get
      .mockResolvedValueOnce(null) // No cached recommendations
      .mockResolvedValueOnce(JSON.stringify(['tech', 'ai'])); // User tags

    await getRecommendationsRoute(mockContext);

    // Verify vector query requests large initial set
    expect(mockVectorIndex.query).toHaveBeenCalledWith({
      vector: mockUserVector,
      topK: 200, // Increased from previous 40-50 limit
      includeMetadata: true,
    });

    // Verify response structure includes all filtered candidates
    expect(mockContext.json).toHaveBeenCalledWith({
      recommendations: expect.arrayContaining([
        expect.objectContaining({
          event_id: expect.any(String),
          score: expect.any(Number),
          diversified: expect.any(Boolean),
        })
      ]),
      metadata: expect.objectContaining({
        user_id: userId,
        ab_group: 'B',
        exploration_rate: 0.3,
        total_candidates: expect.any(Number),
        cache_hit: false,
      })
    });

    // Should return significantly more than old 15-item limit
    const call = mockContext.json.mock.calls[0][0];
    expect(call.recommendations.length).toBeGreaterThan(50);
  });

  /**
   * TinyBird Trending Fallback: Cold start handling
   * 
   * For new users or users with zero vectors, the system should leverage
   * TinyBird's real-time trending data to provide relevant recommendations.
   * This tests the integration with the new analytics service.
   */
  it('should use TinyBird trending data for cold start users', async () => {
    const userId = 'cold-start-user';
    mockContext.req.param.mockReturnValue(userId);

    const zeroVector = new Array(1536).fill(0); // Indicates no user history
    const trendingItems: ExplorationItem[] = Array.from({ length: 75 }, (_, i) => ({
      event_id: `trending-${i}`,
      score: 0.95 - (i * 0.01),
      exploration_type: 'trending',
      confidence: 0.8,
    }));

    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue(zeroVector);
    vi.mocked(analytics.getTrendingItems).mockResolvedValue(trendingItems);

    await getRecommendationsRoute(mockContext);

    // Verify TinyBird trending is called with increased limit
    expect(analytics.getTrendingItems).toHaveBeenCalledWith(mockContext, 100);

    // Verify fallback response structure
    expect(mockContext.json).toHaveBeenCalledWith({
      recommendations: expect.arrayContaining([
        expect.objectContaining({
          event_id: expect.stringMatching(/^trending-/),
          score: expect.any(Number),
          diversified: false,
        })
      ]),
      metadata: expect.objectContaining({
        user_id: userId,
        fallback: 'trending',
        total_candidates: trendingItems.length,
      })
    });
  });

  /**
   * Dynamic Diversification: Adaptive algorithm
   * 
   * The new system applies diversification based on available candidates
   * (80% main results + 20% diverse) rather than fixed numbers.
   * This ensures consistent quality regardless of data volume.
   */
  it('should apply dynamic diversification based on candidate volume', async () => {
    const userId = 'diversification-user';
    mockContext.req.param.mockReturnValue(userId);

    // Mock moderate candidate set that qualifies for diversification
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      id: `event-${i}`,
      score: 0.9 - (i * 0.02),
      metadata: { tags: ['tech'], title: `Event ${i}` }
    }));

    const mockUserVector = Array.from({ length: 1536 }, () => Math.random());
    
    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue(mockUserVector);
    vi.mocked(utils.getABTestGroup).mockResolvedValue('A'); // Group A uses diversification
    mockVectorIndex.query.mockResolvedValue(candidates);
    vi.mocked(explorationService.getExplorationRate).mockResolvedValue(0);

    await getRecommendationsRoute(mockContext);

    const response = mockContext.json.mock.calls[0][0];
    
    // Should have both main and diversified results
    const diversifiedCount = response.recommendations.filter((r: any) => r.diversified).length;
    const mainCount = response.recommendations.filter((r: any) => !r.diversified).length;

    // Verify 80/20 split for diversification
    expect(diversifiedCount).toBeGreaterThan(0);
    expect(mainCount).toBeGreaterThan(diversifiedCount);
    expect(diversifiedCount / (diversifiedCount + mainCount)).toBeCloseTo(0.2, 1);
  });

  /**
   * Enhanced Exploration Integration: TinyBird-powered features
   * 
   * Tests the integration with TinyBird-powered exploration features:
   * - Anti-correlated recommendations
   * - Serendipity items based on user behavior patterns
   * - Real-time trending injection
   */
  it('should integrate TinyBird-powered exploration features proportionally', async () => {
    const userId = 'exploration-user';
    mockContext.req.param.mockReturnValue(userId);

    const candidates = Array.from({ length: 60 }, (_, i) => ({
      id: `event-${i}`,
      score: 0.8 + (Math.random() * 0.2),
      metadata: { tags: ['tech'], title: `Event ${i}` }
    }));

    const mockUserVector = Array.from({ length: 1536 }, () => Math.random());
    
    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue(mockUserVector);
    mockVectorIndex.query.mockResolvedValue(candidates);
    vi.mocked(explorationService.getExplorationRate).mockResolvedValue(0.4); // High exploration rate

    // Mock Math.random to ensure exploration triggers
    vi.spyOn(Math, 'random').mockReturnValue(0.3); // Less than exploration rate of 0.4

    // Mock TinyBird exploration services
    vi.mocked(analytics.getAntiCorrelatedRecommendations).mockResolvedValue([
      { event_id: 'anti-1', score: 0.7, exploration_type: 'anti_correlated', confidence: 0.6 }
    ]);
    vi.mocked(analytics.getSerendipityItems).mockResolvedValue([
      { event_id: 'serendipity-1', score: 0.75, exploration_type: 'serendipity', confidence: 0.8 }
    ]);
    vi.mocked(analytics.getTrendingItems).mockResolvedValue([
      { event_id: 'trending-1', score: 0.85, exploration_type: 'trending', confidence: 0.9 }
    ]);

    // Mock exploration injection
    vi.mocked(explorationService.injectExploration).mockImplementation((recs, items) => [
      ...recs.slice(0, -items.length),
      ...items.map(item => ({
        event_id: item.event_id,
        score: item.score,
        diversified: false,
      }))
    ]);

    await getRecommendationsRoute(mockContext);

    // Verify proportional exploration calls based on candidate volume (15% of 60 = 9, divided by 3 types = 3 each)
    expect(analytics.getAntiCorrelatedRecommendations).toHaveBeenCalledWith(mockUserVector, mockVectorIndex, 3);
    expect(analytics.getSerendipityItems).toHaveBeenCalledWith(userId, mockVectorIndex, mockContext, 3);
    expect(analytics.getTrendingItems).toHaveBeenCalledWith(mockContext, 3);

    // Verify exploration injection was called
    expect(explorationService.injectExploration).toHaveBeenCalled();
  });

  /**
   * Cache Hit Scenario: Performance optimization verification
   * 
   * Tests that cached recommendations are properly transformed to the new response format
   * while maintaining metadata about the cache hit for debugging.
   */
  it('should handle cached recommendations with proper metadata', async () => {
    const userId = 'cached-user';
    mockContext.req.param.mockReturnValue(userId);

    const cachedRecs = [
      { event_id: 'cached-1', score: 0.9, diversified: false },
      { event_id: 'cached-2', score: 0.8, diversified: true },
    ];

    mockContext.env.CACHE.get.mockResolvedValue(JSON.stringify(cachedRecs));
    vi.mocked(explorationService.getExplorationRate).mockResolvedValue(0.2);

    await getRecommendationsRoute(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith({
      recommendations: cachedRecs,
      metadata: expect.objectContaining({
        user_id: userId,
        cache_hit: true,
        total_candidates: cachedRecs.length,
        exploration_rate: 0.2,
      })
    });

    // Should not call vector services for cache hits
    expect(mockVectorIndex.query).not.toHaveBeenCalled();
    expect(recommendationsService.computeHybridUserVector).not.toHaveBeenCalled();
  });

  /**
   * Empty Results Handling: Graceful degradation
   * 
   * Tests how the system handles edge cases where no recommendations can be generated,
   * ensuring the API contract is maintained even in failure scenarios.
   */
  it('should handle empty recommendation sets gracefully', async () => {
    const userId = 'empty-user';
    mockContext.req.param.mockReturnValue(userId);

    const mockUserVector = Array.from({ length: 1536 }, () => Math.random());
    
    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue(mockUserVector);
    mockVectorIndex.query.mockResolvedValue([]); // No results from vector search
    
    // User has very specific tags that don't match anything
    mockContext.env.CACHE.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(['very-specific-tag']));

    await getRecommendationsRoute(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith({
      recommendations: [],
      metadata: expect.objectContaining({
        user_id: userId,
        total_candidates: 0,
        cache_hit: false,
      })
    });
  });

  /**
   * Error Handling: Service resilience
   * 
   * Tests that the system gracefully handles failures in the recommendation pipeline
   * while providing meaningful error context for debugging.
   */
  it('should handle recommendation service failures gracefully', async () => {
    const userId = 'error-user';
    mockContext.req.param.mockReturnValue(userId);

    vi.mocked(recommendationsService.computeHybridUserVector).mockRejectedValue(
      new Error('Vector computation failed')
    );

    await getRecommendationsRoute(mockContext);

    expect(utils.captureWorkerError).toHaveBeenCalledWith(
      expect.any(Error),
      { context: 'get-recommendations' }
    );
  });

  /**
   * User Preference Filtering: Tag-based recommendation filtering
   * 
   * Tests that user-selected tags properly filter the large candidate set,
   * ensuring personalization works correctly with the new dynamic limits.
   */
  it('should filter large candidate sets based on user tag preferences', async () => {
    const userId = 'filtered-user';
    mockContext.req.param.mockReturnValue(userId);

    // Mock large candidate set with mixed tags
    const allCandidates = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `tech-${i}`,
        score: 0.9,
        metadata: { tags: ['tech', 'ai'], title: `Tech Event ${i}` }
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `music-${i}`,
        score: 0.8,
        metadata: { tags: ['music', 'concert'], title: `Music Event ${i}` }
      }))
    ];

    const mockUserVector = Array.from({ length: 1536 }, () => Math.random());
    
    vi.mocked(recommendationsService.computeHybridUserVector).mockResolvedValue(mockUserVector);
    mockVectorIndex.query.mockResolvedValue(allCandidates);
    vi.mocked(explorationService.getExplorationRate).mockResolvedValue(0);

    // User prefers tech events
    mockContext.env.CACHE.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(['tech', 'ai']));

    await getRecommendationsRoute(mockContext);

    const response = mockContext.json.mock.calls[0][0];
    
    // Should only return tech-related events, filtering out music events
    expect(response.recommendations.every((r: any) => r.event_id.startsWith('tech-'))).toBe(true);
    expect(response.recommendations.length).toBe(50); // All tech events
    expect(response.metadata.total_candidates).toBe(50); // Filtered count
  });
});