// In: src/services/exploration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getAntiCorrelatedRecommendations } from './exploration';
import { withRetry } from '../utils';

vi.mock('../utils', () => ({
  withRetry: vi.fn((fn) => fn()),
}));

describe('getAntiCorrelatedRecommendations', () => {
  it('should invert the user vector and return anti-correlated items', async () => {
    // 1. Setup
    const userVector = [0.1, -0.2, 0.3];
    const invertedVector = [-0.1, 0.2, -0.3];
    const topK = 2;

    const mockQueryResponse = [
      { id: 'anti_1', score: 0.9, metadata: {} },
      { id: 'anti_2', score: 0.8, metadata: {} },
      { id: 'anti_3', score: 0.7, metadata: {} },
    ];
    
    const mockVectorIndex = {
      query: vi.fn().mockResolvedValue(mockQueryResponse),
    } as any;

    // 2. Act
    const results = await getAntiCorrelatedRecommendations(userVector, mockVectorIndex, topK);

    // 3. Assert
    expect(withRetry).toHaveBeenCalled();
    expect(mockVectorIndex.query).toHaveBeenCalledWith({
      vector: invertedVector,
      topK: topK * 2,
      includeMetadata: true,
    });

    expect(results).toHaveLength(topK);
    expect(results[0]).toEqual({
      event_id: 'anti_1',
      score: 0.9,
      exploration_type: 'anti_correlated',
      confidence: 0.6,
    });
    expect(results[1].event_id).toBe('anti_2');
  });
}); 