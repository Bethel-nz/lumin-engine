import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { logInteractionRoute } from './interactions';
import * as database from '../services/database';
import * as tinybird from '../lib/tinybird';
import * as utils from '../utils';
import type { EnvBindings } from '../types';

vi.mock('../services/database');
vi.mock('../lib/tinybird');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    validateInput: vi.fn((data) => data),
    withRetry: vi.fn((fn) => fn()),
  };
});

describe('logInteractionRoute with TinyBird', () => {
  const mockContext = {
    req: {
      json: vi.fn(),
      header: vi.fn(),
    },
    json: vi.fn(),
    env: {
      TINYBIRD_TOKEN: 'test-token',
      CACHE: {
        put: vi.fn(),
        delete: vi.fn(),
      },
    } as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  const mockTinybirdClient = {} as any;
  const mockIngestEndpoint = vi.fn().mockResolvedValue({
    successful_rows: 1,
    quarantined_rows: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
    vi.mocked(tinybird.createInteractionIngestionEndpoint).mockReturnValue(mockIngestEndpoint);
    vi.mocked(database.checkUserExists).mockResolvedValue(true);
    vi.mocked(database.insertInteraction).mockResolvedValue();
  });

  it('should successfully log interaction to TinyBird with enriched data', async () => {
    const interactionData = {
      user_id: 'user-123',
      event_id: 'event-456',
      action: 'click',
      session_id: 'session-789',
      source: 'web',
      duration_ms: 5000,
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header
      .mockReturnValueOnce('192.168.1.100')
      .mockReturnValueOnce('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
      .mockReturnValueOnce('https://example.com/events');

    await logInteractionRoute(mockContext);

    expect(tinybird.getTinybirdClient).toHaveBeenCalledWith(mockContext);
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      timestamp: expect.any(Number),
      ip_hash: expect.any(String),
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      referrer: 'https://example.com/events',
      device_type: 'desktop',
    });

    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs:user-123');
    expect(mockContext.env.CACHE.delete).toHaveBeenCalledWith('recs_hash:user-123');

    expect(mockContext.json).toHaveBeenCalledWith({
      success: true,
      message: 'Interaction logged for user user-123',
    }, 201);
  });

  it('should detect mobile device type from user agent', async () => {
    const interactionData = {
      user_id: 'user-mobile',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-mobile',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header
      .mockReturnValueOnce('10.0.0.1')
      .mockReturnValueOnce('Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1)')
      .mockReturnValueOnce(null);

    await logInteractionRoute(mockContext);

    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      timestamp: expect.any(Number),
      ip_hash: expect.any(String),
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1)',
      referrer: undefined,
      device_type: 'mobile',
    });
  });

  it('should detect tablet device type from user agent', async () => {
    const interactionData = {
      user_id: 'user-tablet',
      event_id: 'event-123',
      action: 'like',
      session_id: 'session-tablet',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('Mozilla/5.0 (iPad; CPU OS 15_0)')
      .mockReturnValueOnce(null);

    await logInteractionRoute(mockContext);

    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      timestamp: expect.any(Number),
      ip_hash: undefined,
      user_agent: 'Mozilla/5.0 (iPad; CPU OS 15_0)',
      referrer: undefined,
      device_type: 'tablet',
    });
  });

  it('should handle select_tags action and update user cache', async () => {
    const interactionData = {
      user_id: 'user-tags',
      event_id: 'event-123',
      action: 'select_tags',
      session_id: 'session-tags',
      tags: ['tech', 'conference'],
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      timestamp: expect.any(Number),
      ip_hash: undefined,
      user_agent: undefined,
      referrer: undefined,
      device_type: 'desktop',
    });

    expect(mockContext.env.CACHE.put).toHaveBeenCalledWith(
      'user_tags:user-tags',
      JSON.stringify(['tech', 'conference']),
      { expirationTtl: 2592000 }
    );
  });

  it('should handle new user signup', async () => {
    const interactionData = {
      user_id: 'new-user',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-new',
    };

    vi.mocked(database.checkUserExists).mockResolvedValue(false);
    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);

    await logInteractionRoute(mockContext);

    expect(database.insertInteraction).toHaveBeenCalledWith(
      mockContext.env.DB,
      {
        user_id: 'new-user',
        event_id: 'initial_signup',
        action: 'signup',
        timestamp: expect.any(Number),
      }
    );

    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...interactionData,
      timestamp: expect.any(Number),
      ip_hash: undefined,
      user_agent: undefined,
      referrer: undefined,
      device_type: 'desktop',
    });
  });

  it('should handle TinyBird ingestion failure', async () => {
    const interactionData = {
      user_id: 'user-fail',
      event_id: 'event-123',
      action: 'click',
      session_id: 'session-fail',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header.mockReturnValue(null);
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

    mockContext.req.json.mockResolvedValue(invalidData);
    vi.mocked(utils.validateInput).mockImplementation(() => {
      throw new Error('Validation failed');
    });

    await logInteractionRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to log interaction'
    );

    expect(mockIngestEndpoint).not.toHaveBeenCalled();
  });

  it('should hash IP addresses for privacy', async () => {
    const interactionData = {
      user_id: 'user-ip',
      event_id: 'event-123',
      action: 'view',
      session_id: 'session-ip',
    };

    mockContext.req.json.mockResolvedValue(interactionData);
    mockContext.req.header
      .mockReturnValueOnce('192.168.1.100')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null);

    await logInteractionRoute(mockContext);

    const call = mockIngestEndpoint.mock.calls[0][0];
    expect(call.ip_hash).toBeDefined();
    expect(call.ip_hash).not.toBe('192.168.1.100');
    expect(call.ip_hash).toMatch(/^\d+$/);
  });
});