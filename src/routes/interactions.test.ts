import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { logInteractionRoute } from './interactions';
import * as database from '../services/database';
import * as tinybird from '../lib/tinybird';
import * as utils from '../utils';
import type { EnvBindings } from '../types';

// Mock external dependencies that would fail in isolation
vi.mock('../services/database');
vi.mock('../lib/tinybird');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    validateInput: vi.fn((data) => data), // Pass through validation for tests
    withRetry: vi.fn((fn) => fn()), // Execute immediately without retry logic
    handleError: vi.fn(), // Mock error handler as a spy
  };
});

/**
 * Interaction Logging Tests with TinyBird Integration
 * 
 * These tests verify the dual-storage approach where interactions are:
 * 1. Stored in TinyBird for real-time analytics and trending calculations
 * 2. User state tracked in D1 for transactional operations (signup detection)
 * 3. Cache invalidation to ensure fresh recommendations
 * 
 * The key insight is that interactions drive the recommendation engine,
 * so we need to test both the data storage and the cache invalidation flows.
 */
describe('logInteractionRoute - TinyBird Integration', () => {
  const mockContext = {
    req: {
      json: vi.fn(),
      header: vi.fn(),
    },
    json: vi.fn(),
    env: {
      TINYBIRD_TOKEN: 'test-token',
      DB: {},
      CACHE: {
        put: vi.fn(),
        delete: vi.fn(),
      },
    } as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  // Mock implementations representing successful service responses
  const mockTinybirdClient = {} as any;
  const mockIngestEndpoint = vi.fn().mockResolvedValue({
    successful_rows: 1,
    quarantined_rows: 0,
  });

  beforeEach(() => {
    vi.resetAllMocks();

    // Reset individual mock functions that were cleared by resetAllMocks
    mockIngestEndpoint.mockResolvedValue({
      successful_rows: 1,
      quarantined_rows: 0,
    });
    mockContext.env.CACHE.delete.mockResolvedValue();
    mockContext.env.CACHE.put.mockResolvedValue();

    // Setup successful default responses
    vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
    vi.mocked(tinybird.createInteractionIngestionEndpoint).mockReturnValue(mockIngestEndpoint);
    vi.mocked(database.checkUserExists).mockResolvedValue(true);
    vi.mocked(database.insertInteraction).mockResolvedValue();
  });

  /**
   * Happy Path: Standard interaction logging
   * 
   * This test verifies the main flow where:
   * - User interaction is enriched with session context and timing
   * - Data flows to TinyBird for analytics pipeline
   * - Cache is invalidated to trigger fresh recommendations
   * - Response confirms successful logging
   */
  it('should successfully log interaction to TinyBird and invalidate recommendation cache', async () => {
    const interactionData = {
      user_id: 'user-123',
      event_id: 'event-456',
      action: 'click',
      session_id: 'session-789',
      source: 'web',
      duration_ms: 5000,
      page_depth: 3,
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    // Verify TinyBird ingestion with timestamp enrichment
    expect(tinybird.getTinybirdClient).toHaveBeenCalledWith(mockContext);
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      timestamp: expect.any(Number), // Enriched with server timestamp
    });

    // Verify cache invalidation for fresh recommendations
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs:user-123');
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs_hash:user-123');

    // Verify success response
    expect(mockContext.json).toHaveBeenCalledWith({
      success: true,
      message: 'Interaction logged for user user-123',
    }, 201);
  });

  /**
   * Tag Selection Flow: User preference updating
   * 
   * When users select tags, we need to:
   * 1. Store the interaction in TinyBird for analytics
   * 2. Update the user's tag preferences in cache for recommendations
   * 3. Ensure tag data flows to both systems correctly
   */
  it('should handle select_tags action and update user preferences cache', async () => {
    const tagInteractionData = {
      user_id: 'user-tags',
      event_id: 'event-123',
      action: 'select_tags',
      session_id: 'session-tags',
      tags: ['ai', 'machine-learning', 'conference'],
    };

    mockContext.req.json.mockResolvedValue(tagInteractionData);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    // Verify TinyBird gets the tag data for analytics
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...tagInteractionData,
      timestamp: expect.any(Number),
    });

    // Verify user tag preferences are cached for recommendation engine
    expect(mockContext.env.CACHE.put).toHaveBeenCalledWith(
      'user_tags:user-tags',
      JSON.stringify(['ai', 'machine-learning', 'conference']),
      { expirationTtl: 2592000 } // 30 days
    );

    // Verify cache invalidation triggers recommendation refresh
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs:user-tags');
  });

  /**
   * New User Detection: Signup flow
   * 
   * When a new user interacts for the first time:
   * 1. We detect they don't exist in D1
   * 2. Create a signup interaction in D1 for user lifecycle tracking
   * 3. Store the actual interaction in TinyBird for analytics
   * This dual approach gives us both analytics and user management capabilities.
   */
  it('should handle new user signup flow correctly', async () => {
    const newUserInteraction = {
      user_id: 'new-user-999',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-new',
    };

    // Mock new user scenario
    vi.mocked(database.checkUserExists).mockResolvedValue(false);
    mockContext.req.json.mockResolvedValue(newUserInteraction);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    // Verify signup interaction is recorded in D1 for user lifecycle
    expect(database.insertInteraction).toHaveBeenCalledWith(
      mockContext.env.DB,
      {
        user_id: 'new-user-999',
        event_id: 'initial_signup',
        action: 'signup',
        timestamp: expect.any(Number),
      }
    );

    // Verify actual interaction goes to TinyBird for analytics
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...newUserInteraction,
      timestamp: expect.any(Number),
    });
  });

  /**
   * Minimal Interaction Data: Backward compatibility
   * 
   * Some clients may send minimal interaction data.
   * The system should handle this gracefully and not fail on missing optional fields.
   */
  it('should handle minimal interaction data gracefully', async () => {
    const minimalInteraction = {
      user_id: 'user-minimal',
      event_id: 'event-123',
      action: 'like',
      session_id: 'session-minimal',
    };

    mockContext.req.json.mockResolvedValue(minimalInteraction);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    // Should still ingest successfully with minimal data
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...minimalInteraction,
      timestamp: expect.any(Number),
    });

    expect(mockContext.json).toHaveBeenCalledWith({
      success: true,
      message: 'Interaction logged for user user-minimal',
    }, 201);
  });

  /**
   * TinyBird Failure Resilience: Service degradation handling
   * 
   * If TinyBird is unavailable, the interaction logging should fail gracefully
   * but provide meaningful error context for debugging and monitoring.
   */
  it('should handle TinyBird service failures gracefully', async () => {
    const interactionData = {
      user_id: 'user-fail',
      event_id: 'event-123',
      action: 'click',
      session_id: 'session-fail',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);
    mockIngestEndpoint.mockRejectedValue(new Error('TinyBird service unavailable'));

    await logInteractionRoute(mockContext);

    // Should trigger error handling with context
    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );
  });

  /**
   * Input Validation: Data integrity protection
   * 
   * Invalid interaction data should be rejected early to prevent
   * corrupt data from entering the analytics pipeline.
   */
  it('should validate interaction data before processing', async () => {
    const invalidInteraction = {
      user_id: 'user-invalid',
      action: 'invalid_action', // Not in allowed enum
      // Missing required event_id
    };

    mockContext.req.json.mockResolvedValue(invalidInteraction);
    vi.mocked(utils.validateInput).mockImplementation(() => {
      throw new Error('Validation failed: invalid action type');
    });

    await logInteractionRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );

    // Should not call external services if validation fails
    expect(mockIngestEndpoint).not.toHaveBeenCalled();
    expect(database.insertInteraction).not.toHaveBeenCalled();
  });

  /**
   * Database Failure Handling: Signup detection resilience
   * 
   * If D1 database fails during user existence check, we should still
   * attempt to log the interaction to TinyBird for analytics continuity.
   */
  it('should handle database failures during user existence check', async () => {
    const interactionData = {
      user_id: 'user-db-fail',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-db-fail',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);
    vi.mocked(database.checkUserExists).mockRejectedValue(new Error('Database connection failed'));

    await logInteractionRoute(mockContext);

    // Should trigger error handling for the entire operation
    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );
  });

  /**
   * Cache Operation Verification: Recommendation freshness
   * 
   * This test specifically verifies that cache invalidation happens correctly,
   * which is crucial for ensuring users get updated recommendations based on their latest interactions.
   */
  it('should invalidate user recommendation cache to ensure freshness', async () => {
    const interactionData = {
      user_id: 'user-cache-test',
      event_id: 'event-123',
      action: 'dislike',
      session_id: 'session-cache',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    // Verify both recommendation cache entries are cleared
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs:user-cache-test');
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs_hash:user-cache-test');

    // Should be called exactly twice (once for each cache key)
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledTimes(2);
  });

  /**
   * Action Type Coverage: Different interaction behaviors
   * 
   * Test that different action types are handled correctly,
   * as they may have different downstream processing requirements.
   */
  it('should handle different action types correctly', async () => {
    const actionTypes = ['view', 'click', 'like', 'dislike', 'signup'] as const;

    for (const action of actionTypes) {
      vi.clearAllMocks();
      
      const interactionData = {
        user_id: `user-${action}`,
        event_id: 'event-123',
        action,
        session_id: `session-${action}`,
      };

      mockContext.req.json.mockResolvedValue(interactionData);
      mockContext.req.header.mockReturnValue(null);

      await logInteractionRoute(mockContext);

      // Each action type should be ingested successfully
      expect(mockIngestEndpoint).toHaveBeenCalledWith({
        ...interactionData,
        timestamp: expect.any(Number),
      });

      // Each should trigger cache invalidation
      expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith(`recs:user-${action}`);
    }
  });
});