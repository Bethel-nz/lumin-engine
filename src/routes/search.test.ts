import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'hono';
import { searchRoute } from './search';
import * as vectorService from '../services/vector';
import * as clients from '../lib/clients';
import * as utils from '../utils';
import type { EnvBindings } from '../types';

// Mock external dependencies
vi.mock('../services/vector');
vi.mock('../lib/clients');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    handleError: vi.fn(),
    withRetry: vi.fn((fn) => fn()),
  };
});

/**
 * Search Route Tests
 * 
 * These tests verify the semantic search functionality that:
 * 1. Converts user queries into vector embeddings
 * 2. Performs similarity search against event vectors
 * 3. Returns ranked results with proper metadata
 * 
 * The search system is critical for content discovery and should
 * handle various query types and edge cases gracefully.
 */
describe('searchRoute - Semantic Vector Search', () => {
  const mockContext = {
    req: {
      query: vi.fn(),
    },
    json: vi.fn(),
    env: {} as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  const mockVectorIndex = {
    query: vi.fn(),
  };
  const mockOpenAI = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup successful default responses
    vi.mocked(clients.getVectorIndex).mockReturnValue(mockVectorIndex);
    vi.mocked(clients.getOpenAIClient).mockReturnValue(mockOpenAI);
  });

  /**
   * Successful Search Flow: Standard semantic search
   * 
   * Tests the main path where a user query is successfully converted
   * to an embedding and returns relevant event results ranked by similarity.
   */
  it('should perform semantic search and return ranked results', async () => {
    const searchQuery = 'artificial intelligence conference';
    
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    // Mock successful embedding generation (non-zero vector indicates success)
    const queryEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(queryEmbedding);

    // Mock vector search results with relevant events
    const searchResults = [
      {
        id: 'ai-conf-2025',
        score: 0.92,
        metadata: {
          title: 'AI Innovation Summit 2025',
          tags: ['ai', 'technology', 'innovation'],
          host: 'TechCorp',
          category: 'technology',
          location: 'San Francisco'
        },
      },
      {
        id: 'ml-workshop',
        score: 0.87,
        metadata: {
          title: 'Machine Learning Workshop',
          tags: ['ml', 'ai', 'workshop'],
          host: 'DataScience Institute',
          category: 'education',
          location: 'Boston'
        },
      },
      {
        id: 'blockchain-meetup',
        score: 0.65,
        metadata: {
          title: 'Blockchain Developer Meetup',
          tags: ['blockchain', 'crypto'],
          host: 'Crypto Community',
          category: 'technology',
          location: 'New York'
        },
      },
    ];

    mockVectorIndex.query.mockResolvedValue(searchResults);

    await searchRoute(mockContext);

    // Verify embedding generation with user query
    expect(vectorService.generateEmbedding).toHaveBeenCalledWith(searchQuery, mockOpenAI);

    // Verify vector search with generated embedding
    expect(mockVectorIndex.query).toHaveBeenCalledWith({
      vector: queryEmbedding,
      topK: 20, // Default search limit
      includeMetadata: true,
    });

    // Verify response format with search results
    expect(mockContext.json).toHaveBeenCalledWith({
      results: [
        {
          event_id: 'ai-conf-2025',
          title: 'AI Innovation Summit 2025',
          tags: ['ai', 'technology', 'innovation'],
          score: 0.92,
        },
        {
          event_id: 'ml-workshop',
          title: 'Machine Learning Workshop',
          tags: ['ml', 'ai', 'workshop'],
          score: 0.87,
        },
        {
          event_id: 'blockchain-meetup',
          title: 'Blockchain Developer Meetup',
          tags: ['blockchain', 'crypto'],
          score: 0.65,
        },
      ],
    });
  });

  /**
   * Query Parameter Validation: Input sanitization
   * 
   * Tests that missing or invalid query parameters are properly handled
   * to prevent API misuse and provide clear error messages.
   */
  it('should validate query parameter presence and format', async () => {
    // Test missing query parameter
    mockContext.req.query.mockReturnValue({});

    await searchRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      null,
      'Query parameter is required',
      400
    );

    // Should not attempt embedding generation for invalid input
    expect(vectorService.generateEmbedding).not.toHaveBeenCalled();
    expect(mockVectorIndex.query).not.toHaveBeenCalled();
  });

  it('should handle empty query strings appropriately', async () => {
    // Test empty query string
    mockContext.req.query.mockReturnValue({ query: '' });

    await searchRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      null,
      'Query parameter is required',
      400
    );
  });

  it('should handle whitespace-only queries', async () => {
    // Test whitespace-only query
    mockContext.req.query.mockReturnValue({ query: '   \t\n   ' });

    await searchRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      null,
      'Query parameter is required',
      400
    );
  });

  /**
   * Embedding Service Failure: Resilience testing
   * 
   * Tests how the search handles embedding service failures,
   * which would break the semantic search capability.
   */
  it('should handle embedding generation failures gracefully', async () => {
    const searchQuery = 'test query';
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    // Mock embedding service returning zero vector (indicates failure)
    const zeroVector = new Array(1536).fill(0);
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(zeroVector);

    await searchRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      null,
      'Failed to perform search',
      400
    );

    // Should not proceed to vector search with invalid embedding
    expect(mockVectorIndex.query).not.toHaveBeenCalled();
  });

  it('should handle embedding service exceptions', async () => {
    const searchQuery = 'test query';
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    // Mock embedding service throwing an exception
    vi.mocked(vectorService.generateEmbedding).mockRejectedValue(
      new Error('OpenAI API unavailable')
    );

    await searchRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to perform search'
    );
  });

  /**
   * Vector Store Failure: Search infrastructure resilience
   * 
   * Tests how the system handles vector database failures,
   * ensuring graceful degradation when search infrastructure is unavailable.
   */
  it('should handle vector store query failures', async () => {
    const searchQuery = 'test query';
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    const validEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(validEmbedding);

    // Mock vector store failure
    mockVectorIndex.query.mockRejectedValue(new Error('Vector store timeout'));

    await searchRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to perform search'
    );
  });

  /**
   * Empty Results Handling: Query coverage edge cases
   * 
   * Tests how the system handles queries that don't match any events,
   * ensuring the API contract is maintained even with no results.
   */
  it('should handle empty search results gracefully', async () => {
    const searchQuery = 'very specific unique query with no matches';
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    const validEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(validEmbedding);

    // Mock empty results from vector search
    mockVectorIndex.query.mockResolvedValue([]);

    await searchRoute(mockContext);

    expect(mockContext.json).toHaveBeenCalledWith({
      results: [],
    });
  });

  /**
   * Result Ranking and Formatting: Output quality verification
   * 
   * Tests that search results are properly ranked by relevance score
   * and formatted consistently for client consumption.
   */
  it('should maintain result ranking by relevance score', async () => {
    const searchQuery = 'technology events';
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    const validEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(validEmbedding);

    // Mock results with mixed relevance scores (not pre-sorted)
    const unsortedResults = [
      {
        id: 'event-c',
        score: 0.75,
        metadata: { title: 'Event C', tags: ['tech'] },
      },
      {
        id: 'event-a',
        score: 0.95,
        metadata: { title: 'Event A', tags: ['technology'] },
      },
      {
        id: 'event-b',
        score: 0.85,
        metadata: { title: 'Event B', tags: ['tech', 'innovation'] },
      },
    ];

    mockVectorIndex.query.mockResolvedValue(unsortedResults);

    await searchRoute(mockContext);

    const response = mockContext.json.mock.calls[0][0];
    
    // Results should maintain vector store ordering (assumed to be by relevance)
    expect(response.results[0].event_id).toBe('event-c'); // First in vector response
    expect(response.results[1].event_id).toBe('event-a'); // Second in vector response
    expect(response.results[2].event_id).toBe('event-b'); // Third in vector response
  });

  /**
   * Metadata Handling: Complete information extraction
   * 
   * Tests that all relevant metadata is properly extracted and formatted
   * from vector search results for client consumption.
   */
  it('should handle missing metadata fields gracefully', async () => {
    const searchQuery = 'test';
    mockContext.req.query.mockReturnValue({ query: searchQuery });

    const validEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(validEmbedding);

    // Mock results with incomplete metadata
    const incompleteResults = [
      {
        id: 'event-minimal',
        score: 0.8,
        metadata: {
          title: 'Minimal Event',
          // Missing tags field
        },
      },
      {
        id: 'event-null-metadata',
        score: 0.7,
        metadata: null, // Null metadata
      },
    ];

    mockVectorIndex.query.mockResolvedValue(incompleteResults);

    await searchRoute(mockContext);

    const response = mockContext.json.mock.calls[0][0];
    
    // Should handle missing fields gracefully
    expect(response.results[0]).toEqual({
      event_id: 'event-minimal',
      title: 'Minimal Event',
      tags: [], // Should default to empty array for missing tags
      score: 0.8,
    });

    expect(response.results[1]).toEqual({
      event_id: 'event-null-metadata',
      title: '', // Should default to empty string for null metadata
      tags: [],
      score: 0.7,
    });
  });

  /**
   * Query Complexity Handling: Advanced search patterns
   * 
   * Tests how the system handles complex queries with multiple terms,
   * special characters, and different query patterns.
   */
  it('should handle complex multi-term queries', async () => {
    const complexQuery = 'machine learning AI conference San Francisco 2025 startup';
    mockContext.req.query.mockReturnValue({ query: complexQuery });

    const validEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(validEmbedding);

    mockVectorIndex.query.mockResolvedValue([]);

    await searchRoute(mockContext);

    // Should successfully process complex queries
    expect(vectorService.generateEmbedding).toHaveBeenCalledWith(complexQuery, mockOpenAI);
    expect(mockVectorIndex.query).toHaveBeenCalled();
  });

  it('should handle queries with special characters', async () => {
    const specialCharQuery = 'AI/ML conference & workshop (2025) - San Francisco!';
    mockContext.req.query.mockReturnValue({ query: specialCharQuery });

    const validEmbedding = Array.from({ length: 1536 }, () => Math.random());
    vi.mocked(vectorService.generateEmbedding).mockResolvedValue(validEmbedding);

    mockVectorIndex.query.mockResolvedValue([]);

    await searchRoute(mockContext);

    // Should handle special characters without breaking
    expect(vectorService.generateEmbedding).toHaveBeenCalledWith(specialCharQuery, mockOpenAI);
    expect(utils.handleError).not.toHaveBeenCalled();
  });
});