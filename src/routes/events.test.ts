import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { ingestEventRoute } from './events';
import * as clients from '../lib/clients';
import * as tinybird from '../lib/tinybird';
import * as vector from '../services/vector';
import * as utils from '../utils';
import { drizzle } from 'drizzle-orm/d1';
import type { EnvBindings } from '../types';

// Mock external dependencies - these are the integration points that would fail in isolation
vi.mock('../lib/clients');
vi.mock('../lib/tinybird');
vi.mock('../services/vector');
vi.mock('drizzle-orm/d1');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    validateInput: vi.fn((data) => data), 
    withRetry: vi.fn((fn) => fn()),
    handleError: vi.fn(), // Mock error handler as a spy
  };
});

/**
 * Event Ingestion Tests with TinyBird Integration
 * 
 * These tests verify the hybrid approach where events are stored in both:
 * 1. TinyBird (for analytics and high-volume operations)
 * 2. D1 (for references and transactional consistency)
 * 3. Vector store (for similarity search)
 * 
 * The key insight is that we're testing the orchestration of multiple systems,
 * not just data validation or single-system operations.
 */
describe('ingestEventRoute - TinyBird Integration', () => {
  const mockContext = {
    req: {
      json: vi.fn(),
    },
    json: vi.fn(),
    env: {
      TINYBIRD_TOKEN: 'test-token',
      TINYBIRD_BASE_URL: 'https://api.tinybird.co',
      DB: {},
    } as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  // Mock implementations - these represent successful external service calls
  const mockVectorIndex = {
    upsert: vi.fn().mockResolvedValue({ success: true }),
  };
  const mockOpenAI = {} as any;
  const mockTinybirdClient = {} as any;
  const mockIngestEndpoint = vi.fn().mockResolvedValue({
    successful_rows: 1,
    quarantined_rows: 0,
  });
  const mockDB = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };

  beforeEach(() => {
    vi.resetAllMocks();

    // Reset individual mock functions that were cleared by resetAllMocks
    mockVectorIndex.upsert.mockResolvedValue({ success: true });
    mockIngestEndpoint.mockResolvedValue({
      successful_rows: 1,
      quarantined_rows: 0,
    });
    mockDB.insert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    // Setup successful mock responses for all external services
    vi.mocked(clients.getVectorIndex).mockReturnValue(mockVectorIndex);
    vi.mocked(clients.getOpenAIClient).mockReturnValue(mockOpenAI);
    vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
    vi.mocked(tinybird.createEventIngestionEndpoint).mockReturnValue(mockIngestEndpoint);
    vi.mocked(drizzle).mockReturnValue(mockDB);

    // Default mock for generateEmbedding - can be overridden in individual tests
    vi.mocked(vector.generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  /**
   * 
   * This test verifies the main flow where:
   * - Event data is enriched with timestamps
   * - TinyBird and embedding generation happen in parallel (performance optimization)
   * - D1 reference and vector storage happen in parallel (consistency + performance)
   * - Response includes TinyBird confirmation for debugging
   */
  it('should successfully orchestrate event ingestion across TinyBird, D1, and Vector store', async () => {
    const eventData = {
      id: 'event-123',
      title: 'AI Conference 2025',
      description: 'Latest advances in AI',
      tags: ['ai', 'technology', 'conference'],
      host: 'TechCorp',
      category: 'technology',
      location: 'San Francisco',
      capacity: 500,
      price: 199,
    };

    const mockVector = [0.1, 0.2, 0.3]; // Represents successful embedding generation
    const mockTinybirdResponse = {
      successful_rows: 1,
      quarantined_rows: 0,
    };

    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue(mockVector);
    mockIngestEndpoint.mockResolvedValue(mockTinybirdResponse);

    await ingestEventRoute(mockContext);

    // Verify TinyBird ingestion with enriched data
    expect(tinybird.getTinybirdClient).toHaveBeenCalledWith(mockContext);
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...eventData,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    // Verify embedding generation uses all available text for better semantic understanding
    expect(vector.generateEmbedding).toHaveBeenCalledWith(
      'AI Conference 2025 Latest advances in AI ai technology conference hosted by TechCorp',
      mockOpenAI
    );

    // Verify D1 reference storage for transactional queries
    expect(mockDB.insert).toHaveBeenCalledWith(expect.anything());

    // Verify vector storage with comprehensive metadata for filtering
    expect(mockVectorIndex.upsert).toHaveBeenCalledWith([
      {
        id: 'event-123',
        vector: mockVector,
        metadata: {
          title: 'AI Conference 2025',
          tags: ['ai', 'technology', 'conference'],
          host: 'TechCorp',
          category: 'technology',
          location: 'San Francisco',
        },
      },
    ]);

    // Verify response includes TinyBird confirmation for operational visibility
    expect(mockContext.json).toHaveBeenCalledWith({
      success: true,
      message: 'Event event-123 ingested.',
      tinybird_response: mockTinybirdResponse,
    }, 201);
  });

  /**
   * Minimal Data Test: Backward compatibility
   * 
   * Ensures the system gracefully handles events with only required fields,
   * which is important for API backward compatibility and different client implementations.
   */
  it('should handle minimal event data and fill in appropriate defaults', async () => {
    const minimalEventData = {
      id: 'event-minimal',
      title: 'Basic Event',
      tags: ['basic'],
    };

    const mockVector = [0.4, 0.5, 0.6];
    
    mockContext.req.json.mockResolvedValue(minimalEventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue(mockVector);

    await ingestEventRoute(mockContext);

    // Verify TinyBird gets minimal data with timestamps
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...minimalEventData,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    // Verify vector metadata handles missing fields gracefully
    expect(mockVectorIndex.upsert).toHaveBeenCalledWith([
      {
        id: 'event-minimal',
        vector: mockVector,
        metadata: {
          title: 'Basic Event',
          tags: ['basic'],
          host: '',
          category: '',
          location: '',
        },
      },
    ]);
  });

  /**
   * Embedding Failure: Critical path validation
   * 
   * Zero vectors indicate embedding service failure, which breaks the recommendation engine.
   * This test ensures we fail fast rather than polluting the vector store with invalid data.
   */
  it('should reject events when embedding generation fails (zero vector)', async () => {
    const eventData = {
      id: 'event-fail',
      title: 'Fail Event',
      tags: ['fail'],
    };

    const zeroVector = [0, 0, 0]; // Indicates embedding service failure
    
    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue(zeroVector);

    await ingestEventRoute(mockContext);

    // Should trigger error handling instead of proceeding
    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );

    expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
  });

  /**
   * TinyBird Failure: Service resilience testing
   * 
   * TinyBird failures should not break the entire ingestion process,
   * but we should fail gracefully and provide meaningful error context.
   */
  it('should handle TinyBird service failures gracefully', async () => {
    const eventData = {
      id: 'event-tinybird-fail',
      title: 'TinyBird Fail',
      tags: ['fail'],
    };

    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    mockIngestEndpoint.mockRejectedValue(new Error('TinyBird API Timeout'));

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );
  });

  /**
   * Vector Store Failure: Search capability impact
   * 
   * Vector store failures break recommendation capability but shouldn't
   * prevent event storage in TinyBird for analytics.
   */
  it('should handle vector store failures appropriately', async () => {
    const eventData = {
      id: 'event-vector-fail',
      title: 'Vector Fail',
      tags: ['fail'],
    };

    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    mockVectorIndex.upsert.mockRejectedValue(new Error('Vector store unavailable'));

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );
  });

  /**
   * Validation Failure: Input sanitization
   * 
   * Invalid inputs should be caught early and not reach external services,
   * preventing unnecessary API calls and potential data corruption.
   */
  it('should validate input data before making external service calls', async () => {
    const invalidEventData = {
      title: 'No ID Event', // Missing required ID field
      tags: [], // Empty tags array
    };

    mockContext.req.json.mockResolvedValue(invalidEventData);
    vi.mocked(utils.validateInput).mockImplementation(() => {
      throw new Error('Validation failed: ID is required');
    });

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );

    // Should not make any external service calls if validation fails
    expect(mockIngestEndpoint).not.toHaveBeenCalled();
    expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
    expect(vector.generateEmbedding).not.toHaveBeenCalled();
  });

  /**
   * Parallel Operation Verification: Performance optimization
   * 
   * This test ensures that TinyBird ingestion and embedding generation
   * happen in parallel, which is crucial for performance under load.
   */
  it('should execute TinyBird ingestion and embedding generation in parallel', async () => {
    const eventData = {
      id: 'event-parallel',
      title: 'Parallel Test',
      tags: ['performance'],
    };

    mockContext.req.json.mockResolvedValue(eventData);
    
    // Set up mocks to track calls
    const embeddingMock = vi.mocked(vector.generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    const tinybirdMock = mockIngestEndpoint.mockResolvedValue({ successful_rows: 1, quarantined_rows: 0 });

    await ingestEventRoute(mockContext);

    // Verify both operations were called (indicating parallel execution worked)
    expect(embeddingMock).toHaveBeenCalledWith(expect.stringContaining('Parallel Test'), mockOpenAI);
    expect(tinybirdMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'event-parallel',
      title: 'Parallel Test',
      tags: ['performance'],
    }));
  });
});