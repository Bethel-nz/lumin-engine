import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'hono';
import { getExplorationRate, injectExploration, trackExplorationSuccess } from './exploration';
import * as database from './database';
import type { EnvBindings, EnrichedRecommendation, ExplorationItem } from '../types';

vi.mock('./database');

/**
 * Exploration Service Tests
 * 
 * These tests verify the exploration/exploitation balance mechanisms:
 * 1. Dynamic exploration rates based on user behavior
 * 2. Intelligent injection of diverse items into recommendations
 * 3. Success tracking for continuous optimization
 * 
 * The exploration system is crucial for preventing filter bubbles
 * and ensuring users discover new content they might enjoy.
 */
describe('Exploration Service', () => {
  const mockEnv = {
    DB: {},
    CACHE: {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    },
  } as unknown as EnvBindings;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Dynamic Exploration Rate Calculation
   * 
   * Tests the algorithm that adjusts exploration rates based on:
   * - User interaction count (more experienced users get less exploration)
   * - Recent engagement rates (low engagement triggers more exploration)
   * This ensures new users get diverse content while experienced users get refined suggestions.
   */
  describe('getExplorationRate', () => {
    it('should return high exploration rate for new users with low engagement', async () => {
      const userId = 'new-user';
      
      // Mock new user with minimal interactions and poor engagement
      vi.mocked(database.getUserInteractionCount).mockResolvedValue(5);
      vi.mocked(database.getRecentEngagementRate).mockResolvedValue(0.2); // Low engagement

      const explorationRate = await getExplorationRate(userId, mockEnv);

      // Should return high exploration rate (capped at 0.6) to help user discover content
      expect(explorationRate).toBeGreaterThan(0.4);
      expect(explorationRate).toBeLessThanOrEqual(0.6);
      
      expect(database.getUserInteractionCount).toHaveBeenCalledWith(mockEnv.DB, userId);
      expect(database.getRecentEngagementRate).toHaveBeenCalledWith(mockEnv.DB, userId);
    });

    it('should return moderate exploration rate for experienced users with good engagement', async () => {
      const userId = 'experienced-user';
      
      // Mock experienced user with many interactions and good engagement
      vi.mocked(database.getUserInteractionCount).mockResolvedValue(50);
      vi.mocked(database.getRecentEngagementRate).mockResolvedValue(0.7); // Good engagement

      const explorationRate = await getExplorationRate(userId, mockEnv);

      // Should return lower exploration rate as user preferences are well-established
      expect(explorationRate).toBeLessThan(0.4);
      expect(explorationRate).toBeGreaterThan(0.1); // But never too low
    });

    it('should boost exploration rate for users with declining engagement', async () => {
      const userId = 'declining-user';
      
      // Mock experienced user but with poor recent engagement (suggesting boredom)
      vi.mocked(database.getUserInteractionCount).mockResolvedValue(30);
      vi.mocked(database.getRecentEngagementRate).mockResolvedValue(0.25); // Below threshold

      const explorationRate = await getExplorationRate(userId, mockEnv);

      // Should boost exploration to re-engage the user
      expect(explorationRate).toBeGreaterThan(0.4);
    });
  });

  /**
   * Exploration Item Injection Strategy
   * 
   * Tests the algorithm that intelligently injects exploration items
   * into recommendation lists at strategic positions to maximize discovery
   * while maintaining overall recommendation quality.
   */
  describe('injectExploration', () => {
    it('should inject exploration items at strategic positions in recommendation list', () => {
      // Mock Math.random to ensure deterministic injection
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.1); // Less than explorationRate

      const mainRecs: EnrichedRecommendation[] = Array.from({ length: 20 }, (_, i) => ({
        event_id: `main-${i}`,
        score: 0.9 - (i * 0.02),
        diversified: false,
      }));

      const explorationItems: ExplorationItem[] = [
        { event_id: 'explore-1', score: 0.7, exploration_type: 'anti_correlated', confidence: 0.8 },
        { event_id: 'explore-2', score: 0.65, exploration_type: 'trending', confidence: 0.9 },
        { event_id: 'explore-3', score: 0.6, exploration_type: 'serendipity', confidence: 0.7 },
      ];

      const explorationRate = 0.3;

      const result = injectExploration(mainRecs, explorationItems, explorationRate);

      // Restore Math.random
      Math.random = originalRandom;

      // Should include both main recommendations and exploration items
      expect(result.length).toBeGreaterThan(mainRecs.length);
      
      // Should contain exploration items
      const explorationEventIds = explorationItems.map(item => item.event_id);
      const resultEventIds = result.map(rec => rec.event_id);
      
      explorationEventIds.forEach(id => {
        expect(resultEventIds).toContain(id);
      });

      // Should maintain high-quality items at top positions
      expect(result[0].score).toBeGreaterThan(0.85);
    });

    it('should handle empty exploration items gracefully', () => {
      const mainRecs: EnrichedRecommendation[] = [
        { event_id: 'main-1', score: 0.9, diversified: false },
        { event_id: 'main-2', score: 0.8, diversified: false },
      ];

      const explorationItems: ExplorationItem[] = [];
      const explorationRate = 0.2;

      const result = injectExploration(mainRecs, explorationItems, explorationRate);

      // Should return original recommendations unchanged
      expect(result).toEqual(mainRecs);
    });

    it('should respect exploration rate limits', () => {
      const mainRecs: EnrichedRecommendation[] = Array.from({ length: 10 }, (_, i) => ({
        event_id: `main-${i}`,
        score: 0.9 - (i * 0.05),
        diversified: false,
      }));

      const explorationItems: ExplorationItem[] = Array.from({ length: 8 }, (_, i) => ({
        event_id: `explore-${i}`,
        score: 0.7,
        exploration_type: 'trending',
        confidence: 0.8,
      }));

      const lowExplorationRate = 0.1; // Should limit exploration items

      const result = injectExploration(mainRecs, explorationItems, lowExplorationRate);

      const explorationCount = result.filter(rec => 
        rec.event_id.startsWith('explore-')
      ).length;

      // Should respect low exploration rate and not inject too many items
      expect(explorationCount).toBeLessThan(3); // Much less than available 8 items
    });
  });

  /**
   * Exploration Success Tracking
   * 
   * Tests the feedback mechanism that tracks which exploration items
   * lead to positive user interactions, enabling continuous optimization
   * of the exploration strategy.
   */
  describe('trackExplorationSuccess', () => {
    it('should track exploration items for future optimization', async () => {
      const userId = 'tracked-user';
      const recommendations: EnrichedRecommendation[] = [
        { event_id: 'main-1', score: 0.9, diversified: false },
        { event_id: 'explore-1', score: 0.7, diversified: true }, // Diversified = exploration item
        { event_id: 'main-2', score: 0.8, diversified: true }, // Another exploration item
      ];

      await trackExplorationSuccess(userId, recommendations, mockEnv);

      // Should store exploration items in cache
      expect(mockEnv.CACHE.put).toHaveBeenCalledWith(
        expect.stringMatching(/^exploration_tracking:tracked-user:\d+$/),
        JSON.stringify(['explore-1', 'main-2']),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
    });

    it('should handle tracking failures gracefully', async () => {
      const userId = 'error-user';
      const recommendations: EnrichedRecommendation[] = [
        { event_id: 'test-1', score: 0.9, diversified: false },
      ];

      // Mock tracking failure
      vi.mocked(database.getUserInteractionCount).mockRejectedValue(
        new Error('Database unavailable')
      );

      // Should not throw error even if tracking fails
      await expect(trackExplorationSuccess(userId, recommendations, mockEnv))
        .resolves.not.toThrow();
    });
  });

  /**
   * Integration Test: Full Exploration Flow
   * 
   * Tests the complete exploration workflow from rate calculation
   * through item injection to success tracking.
   */
  describe('Full Exploration Workflow', () => {
    it('should orchestrate complete exploration flow for optimal user experience', async () => {
      const userId = 'workflow-user';
      
      // Setup user scenario: moderate experience, declining engagement
      vi.mocked(database.getUserInteractionCount).mockResolvedValue(25);
      vi.mocked(database.getRecentEngagementRate).mockResolvedValue(0.28); // Below threshold

      const mainRecs: EnrichedRecommendation[] = Array.from({ length: 15 }, (_, i) => ({
        event_id: `main-${i}`,
        score: 0.9 - (i * 0.03),
        diversified: i % 4 === 0, // Some diversified items
      }));

      const explorationItems: ExplorationItem[] = [
        { event_id: 'anti-1', score: 0.6, exploration_type: 'anti_correlated', confidence: 0.7 },
        { event_id: 'trend-1', score: 0.75, exploration_type: 'trending', confidence: 0.9 },
        { event_id: 'serendipity-1', score: 0.55, exploration_type: 'serendipity', confidence: 0.6 },
      ];

      // Step 1: Calculate exploration rate
      const explorationRate = await getExplorationRate(userId, mockEnv);
      expect(explorationRate).toBeGreaterThan(0.4); // Should be high due to low engagement

      // Step 2: Inject exploration items
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.1); // Ensure injection happens
      
      const enrichedRecs = injectExploration(mainRecs, explorationItems, explorationRate);
      
      Math.random = originalRandom;
      expect(enrichedRecs.length).toBeGreaterThan(mainRecs.length);

      // Step 3: Track for future optimization
      await expect(trackExplorationSuccess(userId, enrichedRecs, mockEnv))
        .resolves.not.toThrow();

      // Verify exploration items were properly integrated
      const hasExplorationItems = enrichedRecs.some(rec => 
        explorationItems.some(item => item.event_id === rec.event_id)
      );
      expect(hasExplorationItems).toBe(true);
    });
  });

  /**
   * Edge Case Handling
   * 
   * Tests how the exploration system handles various edge cases
   * and error conditions gracefully.
   */
  describe('Edge Cases', () => {
    it('should handle database errors gracefully in exploration rate calculation', async () => {
      const userId = 'db-error-user';
      
      vi.mocked(database.getUserInteractionCount).mockRejectedValue(
        new Error('Database connection failed')
      );

      // Should return a safe default rate rather than throwing
      const explorationRate = await getExplorationRate(userId, mockEnv);
      expect(explorationRate).toBeGreaterThan(0);
      expect(explorationRate).toBeLessThanOrEqual(0.6);
    });

    it('should handle empty recommendation lists', () => {
      const emptyRecs: EnrichedRecommendation[] = [];
      const explorationItems: ExplorationItem[] = [
        { event_id: 'explore-1', score: 0.7, exploration_type: 'trending', confidence: 0.8 }
      ];

      const result = injectExploration(emptyRecs, explorationItems, 0.5);

      // Should handle empty input gracefully
      expect(result).toEqual([]);
    });
  });
});