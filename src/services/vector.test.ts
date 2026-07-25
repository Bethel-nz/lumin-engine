import { describe, it, expect, vi } from 'vitest';
import { fetchEventVectors, buildInteractionVector } from './vector';
import { CONFIG } from '../config';

describe('fetchEventVectors', () => {
  it('requests the vector payload, which Upstash omits by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue([]);
    const index = { fetch: fetchMock } as any;

    await fetchEventVectors(index, ['evt-1', 'evt-2']);

    expect(fetchMock).toHaveBeenCalledWith(
      ['evt-1', 'evt-2'],
      expect.objectContaining({ includeVectors: true })
    );
  });

  it('returns nothing for an empty id list without calling Upstash', async () => {
    const fetchMock = vi.fn();
    const index = { fetch: fetchMock } as any;

    await expect(fetchEventVectors(index, [])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildInteractionVector', () => {
  it('builds a non-zero vector from weighted interactions', async () => {
    const dims = CONFIG.EMBEDDING.DIMENSIONS;
    const jazz = new Array(dims).fill(0);
    jazz[0] = 1;
    const pottery = new Array(dims).fill(0);
    pottery[1] = 1;

    const index = {
      fetch: vi
        .fn()
        .mockResolvedValue([
          { id: 'evt-jazz', vector: jazz },
          { id: 'evt-pottery', vector: pottery },
        ]),
    } as any;

    const now = new Date().toISOString();
    const result = await buildInteractionVector(
      [
        { event_id: 'evt-jazz', action: 'like', weight: 2, timestamp: now },
        { event_id: 'evt-pottery', action: 'dislike', weight: -1, timestamp: now },
      ] as any,
      index
    );

    expect(result).toHaveLength(dims);
    expect(result.some((v) => v !== 0)).toBe(true);
    expect(result[0]).toBeGreaterThan(0);
    expect(result[1]).toBeLessThan(0);
  });

  it('returns a zero vector when Upstash omits the vector payload', async () => {
    const index = {
      fetch: vi.fn().mockResolvedValue([{ id: 'evt-jazz', metadata: {} }]),
    } as any;

    const result = await buildInteractionVector(
      [
        {
          event_id: 'evt-jazz',
          action: 'like',
          weight: 2,
          timestamp: new Date().toISOString(),
        },
      ] as any,
      index
    );

    expect(result.every((v) => v === 0)).toBe(true);
  });
});
