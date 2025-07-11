
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logInteractionRoute } from './interactions';
import * as dbService from '../services/database';

vi.mock('../services/database', () => ({
  checkUserExists: vi.fn().mockResolvedValue(true),
  insertInteraction: vi.fn().mockResolvedValue({ success: true }),
}));

const mockCache = {
  delete: vi.fn(),
  put: vi.fn(),
};

const mockEnv = {
  DB: {},
  CACHE: mockCache,
} as any;

const mockContext = (body: any) => ({
  req: {
    json: vi.fn().mockResolvedValue(body),
  },
  env: mockEnv,
  json: vi.fn((data) => new Response(JSON.stringify(data))),
}) as any;

describe('logInteractionRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log an interaction and invalidate cache successfully', async () => {
    const interaction = {
      user_id: 'user_123',
      event_id: 'evt_123',
      action: 'like',
    };
    const context = mockContext(interaction);

    const response = await logInteractionRoute(context);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      success: true,
      message: `Interaction logged for user ${interaction.user_id}`,
    });

    expect(dbService.insertInteraction).toHaveBeenCalled();
    expect(mockCache.delete).toHaveBeenCalledWith(`recs:${interaction.user_id}`);
    expect(mockCache.delete).toHaveBeenCalledWith(
      `recs_hash:${interaction.user_id}`
    );
  });

  it('should return a 400 error for invalid input', async () => {
    const interaction = {
      // Missing event_id and action
      user_id: 'user_123',
    };
    const context = mockContext(interaction);

    const response = await logInteractionRoute(context);

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data?.error).toBe('Validation failed');
  });
}); 