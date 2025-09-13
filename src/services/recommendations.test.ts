import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computeHybridUserVector, getCollaborativeVector } from './recommendations';
import * as db from './database';
import * as vector from './vector';
import { CONFIG } from '../config';

vi.mock('./database');
vi.mock('./vector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vector')>();
  return {
    ...actual,
    combineVectors: actual.combineVectors,
    buildInteractionVector: vi.fn(),
    generateEmbedding: vi.fn(),
  };
});

vi.mock('./recommendations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recommendations')>();
  return {
    ...actual,
    getCollaborativeVector: actual.getCollaborativeVector,
  };
});

const mockOpenAI = {} as any;
const mockVectorIndex = {} as any;

const createMockVector = (seed: number, length = CONFIG.EMBEDDING.DIMENSIONS) => {
  return new Array(length).fill(0).map((_, i) => parseFloat((seed + i * 0.01).toFixed(4)));
};

describe('computeHybridUserVector', () => {
  const userId = 'test_user';
  const mockCache = { get: vi.fn() };
  const mockEnv = {
    DB: {} as any,
    CACHE: mockCache as any,
  } as any;

  beforeEach(() => {
    vi.resetAllMocks();

    // Reset individual mock functions that were cleared by resetAllMocks
    mockCache.get.mockResolvedValue(null);

    // Add default mocks for all tests to avoid undefined errors
    vi.mocked(db.getSimilarUsers).mockResolvedValue([]);
  });

  it('should correctly combine vectors from all available sources', async () => {
    // 1. Setup Mocks
    const combineVectorsSpy = vi.spyOn(vector, 'combineVectors');
    const interactionVec = createMockVector(0.1);
    const tagVec = createMockVector(0.2);
    const collabVec = createMockVector(0.3);
    const demoVec = createMockVector(0.4);

    // Provide a specific mock for this test if needed, otherwise the default will be used
    vi.mocked(db.getSimilarUsers).mockResolvedValue([{ user_id: 'sim_user_1', common_interactions: 2 }]);
    vi.mocked(db.getSimilarUserInteractions).mockResolvedValue([{ event_id: 'sim_evt_1', action: 'like', weight: 1, timestamp: new Date().toISOString() }]);


    const mockInteractions = [{ event_id: '1', action: 'like', weight: 1, timestamp: new Date().toISOString() }];
    vi.mocked(db.getUserInteractions).mockResolvedValue(mockInteractions);
    vi.mocked(db.getUserDemographics).mockResolvedValue({ country: 'US', interests: ['tech'] });
    mockCache.get.mockResolvedValue(JSON.stringify(['music', 'art']));

    vi.mocked(vector.buildInteractionVector)
      .mockResolvedValueOnce(interactionVec) // First call is for direct interactions
      .mockResolvedValueOnce(collabVec); // Second call is inside getCollaborativeVector
    vi.mocked(vector.generateEmbedding)
      .mockResolvedValueOnce(tagVec)
      .mockResolvedValueOnce(demoVec);
    
    // We are no longer mocking getCollaborativeVector itself, but its dependencies.
    // Let the real getCollaborativeVector run.

    // 2. Act
    const finalVector = await computeHybridUserVector(userId, mockEnv, mockOpenAI, mockVectorIndex);

    // 3. Assert
    // Assert that the function is called with the correct components and weights
    expect(combineVectorsSpy).toHaveBeenCalledWith([
      { vector: interactionVec, weight: 0.5 },
      { vector: tagVec, weight: 0.3 },
      { vector: collabVec, weight: 0.2 },
      { vector: demoVec, weight: 0.1 },
    ]);
    
    // Assert the final vector is correctly formatted (normalized)
    expect(finalVector).toHaveLength(CONFIG.EMBEDDING.DIMENSIONS);
    const magnitude = Math.sqrt(finalVector.reduce((acc, val) => acc + val * val, 0));
    expect(magnitude).toBeCloseTo(1);
  });

  it('should handle users with only demographics and no interaction history', async () => {
    // 1. Setup Mocks
    const combineVectorsSpy = vi.spyOn(vector, 'combineVectors');
    const demoVec = createMockVector(0.4);
    const zeroVec = new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);

    vi.mocked(db.getUserInteractions).mockResolvedValue([]); // No interactions
    vi.mocked(db.getUserDemographics).mockResolvedValue({ country: 'CA', interests: ['sports'] });
    mockCache.get.mockResolvedValue(null); // No tags

    vi.mocked(vector.buildInteractionVector).mockResolvedValue(zeroVec); // Zero vector for interactions
    vi.mocked(vector.generateEmbedding).mockResolvedValueOnce(demoVec); // Only called for demographics
    // getCollaborativeVector will be called, but its mocked deps will result in a zero vector

    // 2. Act
    const finalVector = await computeHybridUserVector(userId, mockEnv, mockOpenAI, mockVectorIndex);

    // 3. Assert
    expect(combineVectorsSpy).toHaveBeenCalledWith([
      { vector: zeroVec, weight: 0.5 },
      { vector: zeroVec, weight: 0.3 },
      { vector: zeroVec, weight: 0.2 },
      { vector: demoVec, weight: 0.1 },
    ]);
    
    expect(finalVector).toHaveLength(CONFIG.EMBEDDING.DIMENSIONS);
    const magnitude = Math.sqrt(finalVector.reduce((acc, val) => acc + val * val, 0));
    expect(magnitude).toBeCloseTo(1);
  });

  it('should degrade gracefully and return a zero-vector on database error', async () => {
    // 1. Setup Mocks
    const error = new Error('Database connection failed');
    vi.mocked(db.getUserInteractions).mockRejectedValue(error); // Simulate DB error
    vi.mocked(db.getUserDemographics).mockResolvedValue(null);
    mockCache.get.mockResolvedValue(null);

    // Mock console.error to suppress confusing stderr output during test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 2. Act
    const finalVector = await computeHybridUserVector(userId, mockEnv, mockOpenAI, mockVectorIndex);

    // 3. Assert
    const zeroVector = new Array(CONFIG.EMBEDDING.DIMENSIONS).fill(0);
    expect(finalVector).toEqual(zeroVector);
    // Ensure it didn't proceed to generate embeddings if initial data fetch failed
    expect(vector.generateEmbedding).not.toHaveBeenCalled();
    // Verify error was logged (even though we suppressed the output)
    expect(consoleSpy).toHaveBeenCalledWith('Error computing hybrid user vector:', error);

    consoleSpy.mockRestore();
  });
}); 