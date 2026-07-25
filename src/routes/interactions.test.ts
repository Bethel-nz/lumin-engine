import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { logInteractionRoute } from './interactions';
import * as database from '../services/database';
import * as tinybird from '../lib/tinybird';
import * as utils from '../utils';
import { createD1Mock } from '../lib/test-utils';
import type { EnvBindings } from '../types';

// Mock external dependencies that would fail in isolation
vi.mock('../services/database');
vi.mock('../lib/tinybird');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    withRetry: vi.fn((fn) => fn()), // Execute immediately without retry logic
    handleError: vi.fn(), // Mock error handler as a spy
  };
});

/**
 * Interaction Logging Tests with TinyBird Integration
 *
 * These tests verify the dual-storage approach where interactions are:
 * 1. Stored in TinyBird for real-time analytics and trending calculations
 * 2. Mirrored into D1 for transactional queries, keyed by a caller-supplied id
 *    so replays are idempotent
 * 3. Followed by cache invalidation so recommendations stay fresh
 *
 * Note the route validates with logInteractionSchema.parse directly, so `id` is
 * required on every payload and `source` is defaulted to 'web' before the data
 * reaches TinyBird.
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
      DB: createD1Mock(),
      CACHE: {
        put: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  // Mock implementations representing successful service responses
  const mockTinybirdClient = {} as any;
  const mockIngestEndpoint = vi.fn().mockResolvedValue({
    successful_rows: 1,
    quarantined_rows: 0,
  });

  beforeEach(() => {
    vi.resetAllMocks();

    // resetAllMocks strips the chainable implementations, so rebuild D1 each time
    (mockContext.env as unknown as { DB: unknown }).DB = createD1Mock();

    // Reset individual mock functions that were cleared by resetAllMocks
    mockIngestEndpoint.mockResolvedValue({
      successful_rows: 1,
      quarantined_rows: 0,
    });
    vi.mocked(mockContext.env.CACHE.delete).mockResolvedValue();
    vi.mocked(mockContext.env.CACHE.put).mockResolvedValue();

    // Setup successful default responses
    vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
    vi.mocked(tinybird.createInteractionIngestionEndpoint).mockReturnValue(
      mockIngestEndpoint
    );
    vi.mocked(database.upsertUserProfile).mockResolvedValue();
    vi.mocked(database.insertInteraction).mockResolvedValue();
  });

  /**
   * Happy Path: Standard interaction logging
   *
   * Verifies the main flow where:
   * - The user profile is upserted so first-time users are tracked
   * - The interaction is mirrored into D1 and ingested into TinyBird
   * - Both recommendation cache keys are invalidated
   * - The response echoes the interaction id
   */
  it('should successfully log interaction to TinyBird and invalidate recommendation cache', async () => {
    const interactionData = {
      id: 'interaction-001',
      user_id: 'user-123',
      event_id: 'event-456',
      action: 'click',
      session_id: 'session-789',
      source: 'web',
      duration_ms: 5000,
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

    await logInteractionRoute(mockContext);

    // The profile upsert is idempotent and runs for every interaction
    expect(database.upsertUserProfile).toHaveBeenCalledWith(
      mockContext.env.DB,
      'user-123'
    );

    // D1 mirror carries the caller-supplied id for idempotent replays
    expect(database.insertInteraction).toHaveBeenCalledWith(mockContext.env.DB, {
      id: 'interaction-001',
      user_id: 'user-123',
      event_id: 'event-456',
      action: 'click',
      timestamp: expect.any(Number),
    });

    // TinyBird receives the parsed payload; timestamp enrichment happens inside
    // createInteractionIngestionEndpoint, not here
    expect(tinybird.getTinybirdClient).toHaveBeenCalledWith(mockContext);
    expect(mockIngestEndpoint).toHaveBeenCalledWith(interactionData);

    // Verify cache invalidation for fresh recommendations
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs:user-123');
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith(
      'recs_hash:user-123'
    );

    // Verify success response
    expect(mockContext.json).toHaveBeenCalledWith(
      {
        success: true,
        interaction_id: 'interaction-001',
        message: 'Interaction logged for user user-123',
      },
      201
    );
  });

  /**
   * Tag Selection Flow: User preference updating
   *
   * select_tags is a preference signal rather than an item interaction, so it
   * is deliberately NOT mirrored into D1 - it only updates the tag cache and
   * flows to TinyBird for analytics.
   */
  it('should handle select_tags action and update user preferences cache', async () => {
    const tagInteractionData = {
      id: 'interaction-tags',
      user_id: 'user-tags',
      event_id: 'event-123',
      action: 'select_tags',
      session_id: 'session-tags',
      source: 'web',
      tags: ['ai', 'machine-learning', 'conference'],
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(tagInteractionData);

    await logInteractionRoute(mockContext);

    // Verify TinyBird gets the tag data for analytics
    expect(mockIngestEndpoint).toHaveBeenCalledWith(tagInteractionData);

    // select_tags is a preference signal, not an item interaction
    expect(database.insertInteraction).not.toHaveBeenCalled();

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
   * New User Tracking: Profile upsert
   *
   * First-time users no longer get a synthetic 'initial_signup' interaction
   * row. upsertUserProfile handles both creation and last-seen tracking, so a
   * brand new user takes exactly the same path as a returning one.
   */
  it('should upsert the profile for a first-time user without a synthetic signup row', async () => {
    const newUserInteraction = {
      id: 'interaction-new',
      user_id: 'new-user-999',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-new',
      source: 'web',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(newUserInteraction);

    await logInteractionRoute(mockContext);

    expect(database.upsertUserProfile).toHaveBeenCalledWith(
      mockContext.env.DB,
      'new-user-999'
    );

    // The real interaction is mirrored - no 'initial_signup' placeholder
    expect(database.insertInteraction).toHaveBeenCalledWith(mockContext.env.DB, {
      id: 'interaction-new',
      user_id: 'new-user-999',
      event_id: 'event-123',
      action: 'view',
      timestamp: expect.any(Number),
    });

    expect(mockIngestEndpoint).toHaveBeenCalledWith(newUserInteraction);
  });

  /**
   * Signup Action: Lifecycle event, not an item interaction
   *
   * A 'signup' action carries no meaningful item, so it is kept out of the D1
   * interactions table while still reaching TinyBird.
   */
  it('should not mirror signup actions into D1', async () => {
    const signupInteraction = {
      id: 'interaction-signup',
      user_id: 'user-signup',
      event_id: 'event-123',
      action: 'signup',
      session_id: 'session-signup',
      source: 'web',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(signupInteraction);

    await logInteractionRoute(mockContext);

    expect(database.upsertUserProfile).toHaveBeenCalledWith(
      mockContext.env.DB,
      'user-signup'
    );
    expect(database.insertInteraction).not.toHaveBeenCalled();
    expect(mockIngestEndpoint).toHaveBeenCalledWith(signupInteraction);
  });

  /**
   * Minimal Interaction Data: Schema defaults
   *
   * Clients may omit optional fields. `source` defaults to 'web' during parsing,
   * so TinyBird always receives it.
   */
  it('should handle minimal interaction data gracefully', async () => {
    const minimalInteraction = {
      id: 'interaction-minimal',
      user_id: 'user-minimal',
      event_id: 'event-123',
      action: 'like',
      session_id: 'session-minimal',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(minimalInteraction);

    await logInteractionRoute(mockContext);

    // Should still ingest successfully, with source defaulted by the schema
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...minimalInteraction,
      source: 'web',
    });

    expect(mockContext.json).toHaveBeenCalledWith(
      {
        success: true,
        interaction_id: 'interaction-minimal',
        message: 'Interaction logged for user user-minimal',
      },
      201
    );
  });

  /**
   * TinyBird Failure Resilience: Service degradation handling
   *
   * Unlike event ingestion, interaction logging has no compensation queue, so a
   * TinyBird outage surfaces as an error the caller can retry.
   */
  it('should handle TinyBird service failures gracefully', async () => {
    const interactionData = {
      id: 'interaction-fail',
      user_id: 'user-fail',
      event_id: 'event-123',
      action: 'click',
      session_id: 'session-fail',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);
    mockIngestEndpoint.mockRejectedValue(
      new Error('TinyBird service unavailable')
    );

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
   * The route parses with zod directly, so a bad action enum and a missing
   * event_id are rejected before any external service is touched.
   */
  it('should validate interaction data before processing', async () => {
    const invalidInteraction = {
      id: 'interaction-invalid',
      user_id: 'user-invalid',
      action: 'invalid_action', // Not in allowed enum
      session_id: 'session-invalid',
      // Missing required event_id
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(invalidInteraction);

    await logInteractionRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );

    // Should not call external services if validation fails
    expect(mockIngestEndpoint).not.toHaveBeenCalled();
    expect(database.insertInteraction).not.toHaveBeenCalled();
    expect(database.upsertUserProfile).not.toHaveBeenCalled();
  });

  /**
   * select_tags Guard: Schema-level refinement
   *
   * logInteractionSchema refuses a select_tags action with no tags, since it
   * would write an empty preference set over the user's real one.
   */
  it('should reject select_tags with no tags', async () => {
    const taglessSelection = {
      id: 'interaction-no-tags',
      user_id: 'user-no-tags',
      event_id: 'event-123',
      action: 'select_tags',
      session_id: 'session-no-tags',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(taglessSelection);

    await logInteractionRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );
    expect(mockContext.env.CACHE.put).not.toHaveBeenCalled();
  });

  /**
   * Database Failure Handling: Profile upsert resilience
   *
   * The profile upsert runs before ingestion, so a D1 outage fails the whole
   * request rather than silently dropping the user record.
   */
  it('should handle database failures during profile upsert', async () => {
    const interactionData = {
      id: 'interaction-db-fail',
      user_id: 'user-db-fail',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-db-fail',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);
    vi.mocked(database.upsertUserProfile).mockRejectedValue(
      new Error('Database connection failed')
    );

    await logInteractionRoute(mockContext);

    // Should trigger error handling for the entire operation
    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );

    // Ingestion must not proceed on a failed upsert
    expect(mockIngestEndpoint).not.toHaveBeenCalled();
  });

  /**
   * Cache Operation Verification: Recommendation freshness
   *
   * Verifies cache invalidation happens correctly, which is crucial for
   * ensuring users get recommendations reflecting their latest interactions.
   */
  it('should invalidate user recommendation cache to ensure freshness', async () => {
    const interactionData = {
      id: 'interaction-cache',
      user_id: 'user-cache-test',
      event_id: 'event-123',
      action: 'dislike',
      session_id: 'session-cache',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

    await logInteractionRoute(mockContext);

    // Verify both recommendation cache entries are cleared
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith(
      'recs:user-cache-test'
    );
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith(
      'recs_hash:user-cache-test'
    );

    // Should be called exactly twice (once for each cache key)
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledTimes(2);
  });

  /**
   * Action Type Coverage: Different interaction behaviors
   *
   * Item-level actions all take the same path: mirrored into D1 and ingested.
   * signup and select_tags diverge and are covered by their own tests.
   */
  it('should handle different action types correctly', async () => {
    const actionTypes = ['view', 'click', 'like', 'dislike'] as const;

    for (const action of actionTypes) {
      vi.clearAllMocks();
      vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
      vi.mocked(tinybird.createInteractionIngestionEndpoint).mockReturnValue(
        mockIngestEndpoint
      );
      mockIngestEndpoint.mockResolvedValue({
        successful_rows: 1,
        quarantined_rows: 0,
      });

      const interactionData = {
        id: `interaction-${action}`,
        user_id: `user-${action}`,
        event_id: 'event-123',
        action,
        session_id: `session-${action}`,
        source: 'web',
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

      await logInteractionRoute(mockContext);

      // Each action type should be ingested successfully
      expect(mockIngestEndpoint).toHaveBeenCalledWith(interactionData);

      // Each should be mirrored into D1
      expect(database.insertInteraction).toHaveBeenCalledWith(
        mockContext.env.DB,
        {
          id: `interaction-${action}`,
          user_id: `user-${action}`,
          event_id: 'event-123',
          action,
          timestamp: expect.any(Number),
        }
      );

      // Each should trigger cache invalidation
      expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith(
        `recs:user-${action}`
      );
    }
  });
});
