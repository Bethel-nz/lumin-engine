import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { logInteractionRoute } from './interactions';
import * as database from '../services/database';
import * as tinybird from '../lib/tinybird';
import * as utils from '../utils';
import { createD1Mock } from '../lib/test-utils';
import type { EnvBindings } from '../types';

vi.mock('../services/database');
vi.mock('../lib/tinybird');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    withRetry: vi.fn((fn) => fn()),
    handleError: vi.fn(), // Mock error handler as a spy
  };
});

/**
 * Focused on what reaches TinyBird. The route does not read request headers -
 * client context arrives as the caller-supplied `source` field - so these tests
 * exercise source passthrough rather than user-agent sniffing.
 */
describe('logInteractionRoute with TinyBird', () => {
  const mockContext = {
    req: {
      json: vi.fn(),
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

  const mockTinybirdClient = {} as any;
  const mockIngestEndpoint = vi.fn().mockResolvedValue({
    successful_rows: 1,
    quarantined_rows: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (mockContext.env as unknown as { DB: unknown }).DB = createD1Mock();
    mockIngestEndpoint.mockResolvedValue({
      successful_rows: 1,
      quarantined_rows: 0,
    });
    vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
    vi.mocked(tinybird.createInteractionIngestionEndpoint).mockReturnValue(
      mockIngestEndpoint
    );
    vi.mocked(database.upsertUserProfile).mockResolvedValue();
    vi.mocked(database.insertInteraction).mockResolvedValue();
  });

  it('should successfully log interaction to TinyBird with enriched data', async () => {
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

    expect(tinybird.getTinybirdClient).toHaveBeenCalledWith(mockContext);
    expect(tinybird.createInteractionIngestionEndpoint).toHaveBeenCalledWith(
      mockTinybirdClient
    );
    expect(mockIngestEndpoint).toHaveBeenCalledWith(interactionData);

    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs:user-123');
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith(
      'recs_hash:user-123'
    );

    expect(mockContext.json).toHaveBeenCalledWith(
      {
        success: true,
        interaction_id: 'interaction-001',
        message: 'Interaction logged for user user-123',
      },
      201
    );
  });

  it('should pass the client source through to TinyBird unchanged', async () => {
    for (const source of ['web', 'ios', 'android', 'tablet']) {
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
        id: `interaction-${source}`,
        user_id: `user-${source}`,
        event_id: 'event-123',
        action: 'view',
        session_id: `session-${source}`,
        source,
      };

      vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

      await logInteractionRoute(mockContext);

      expect(mockIngestEndpoint).toHaveBeenCalledWith(interactionData);
    }
  });

  it('should default a missing source to web', async () => {
    const interactionData = {
      id: 'interaction-nosource',
      user_id: 'user-nosource',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-nosource',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

    await logInteractionRoute(mockContext);

    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      source: 'web',
    });
  });

  it('should handle select_tags action and update user cache', async () => {
    const interactionData = {
      id: 'interaction-tags',
      user_id: 'user-tags',
      event_id: 'event-123',
      action: 'select_tags',
      session_id: 'session-tags',
      source: 'web',
      tags: ['tech', 'conference'],
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

    await logInteractionRoute(mockContext);

    expect(mockIngestEndpoint).toHaveBeenCalledWith(interactionData);

    expect(mockContext.env.CACHE.put).toHaveBeenCalledWith(
      'user_tags:user-tags',
      JSON.stringify(['tech', 'conference']),
      { expirationTtl: 2592000 }
    );
  });

  it('should upsert the profile for a new user', async () => {
    const interactionData = {
      id: 'interaction-new',
      user_id: 'new-user',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-new',
      source: 'web',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);

    await logInteractionRoute(mockContext);

    expect(database.upsertUserProfile).toHaveBeenCalledWith(
      mockContext.env.DB,
      'new-user'
    );

    expect(database.insertInteraction).toHaveBeenCalledWith(
      mockContext.env.DB,
      {
        id: 'interaction-new',
        user_id: 'new-user',
        event_id: 'event-123',
        action: 'view',
        timestamp: expect.any(Number),
      }
    );

    expect(mockIngestEndpoint).toHaveBeenCalledWith(interactionData);
  });

  it('should handle TinyBird ingestion failure', async () => {
    const interactionData = {
      id: 'interaction-fail',
      user_id: 'user-fail',
      event_id: 'event-123',
      action: 'click',
      session_id: 'session-fail',
      source: 'web',
    };

    vi.mocked(mockContext.req.json).mockResolvedValue(interactionData);
    mockIngestEndpoint.mockRejectedValue(new Error('TinyBird API Error'));

    await logInteractionRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );
  });

  it('should handle validation errors', async () => {
    const invalidData = { user_id: 'user', action: 'invalid' };

    vi.mocked(mockContext.req.json).mockResolvedValue(invalidData);

    await logInteractionRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );

    expect(mockIngestEndpoint).not.toHaveBeenCalled();
  });
});
