import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { ingestEventRoute } from './events';
import * as clients from '../lib/clients';
import * as tinybird from '../lib/tinybird';
import * as vector from '../services/vector';
import * as utils from '../utils';
import type { EnvBindings } from '../types';

vi.mock('../lib/clients');
vi.mock('../lib/tinybird');
vi.mock('../services/vector');
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    validateInput: vi.fn((data) => data),
    withRetry: vi.fn((fn) => fn()),
  };
});

describe('ingestEventRoute with TinyBird', () => {
  const mockContext = {
    req: {
      json: vi.fn(),
    },
    json: vi.fn(),
    env: {
      TINYBIRD_TOKEN: 'test-token',
      TINYBIRD_BASE_URL: 'https://api.tinybird.co',
    } as EnvBindings,
  } as unknown as Context<{ Bindings: EnvBindings }>;

  const mockVectorIndex = {
    upsert: vi.fn().mockResolvedValue({ success: true }),
  };

  const mockOpenAI = {} as any;
  
  const mockTinybirdClient = {} as any;
  const mockIngestEndpoint = vi.fn().mockResolvedValue({
    successful_rows: 1,
    quarantined_rows: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clients.getVectorIndex).mockReturnValue(mockVectorIndex);
    vi.mocked(clients.getOpenAIClient).mockReturnValue(mockOpenAI);
    vi.mocked(tinybird.getTinybirdClient).mockReturnValue(mockTinybirdClient);
    vi.mocked(tinybird.createEventIngestionEndpoint).mockReturnValue(mockIngestEndpoint);
  });

  it('should successfully ingest event to TinyBird and Vector store in parallel', async () => {
    const eventData = {
      id: 'event-123',
      title: 'Test Event',
      description: 'A test event',
      tags: ['tech', 'conference'],
      host: 'Test Host',
      category: 'technology',
      location: 'San Francisco',
      capacity: 100,
      price: 50,
    };

    const mockVector = [0.1, 0.2, 0.3];
    const mockTinybirdResponse = {
      successful_rows: 1,
      quarantined_rows: 0,
    };

    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue(mockVector);
    mockIngestEndpoint.mockResolvedValue(mockTinybirdResponse);

    await ingestEventRoute(mockContext);

    expect(tinybird.getTinybirdClient).toHaveBeenCalledWith(mockContext);
    expect(tinybird.createEventIngestionEndpoint).toHaveBeenCalledWith(mockTinybirdClient);
    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...eventData,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    expect(vector.generateEmbedding).toHaveBeenCalledWith(
      'Test Event A test event tech conference hosted by Test Host',
      mockOpenAI
    );

    expect(mockVectorIndex.upsert).toHaveBeenCalledWith([
      {
        id: 'event-123',
        vector: mockVector,
        metadata: {
          title: 'Test Event',
          tags: ['tech', 'conference'],
          host: 'Test Host',
          category: 'technology',
          location: 'San Francisco',
        },
      },
    ]);

    expect(mockContext.json).toHaveBeenCalledWith({
      success: true,
      message: 'Event event-123 ingested.',
      tinybird_response: mockTinybirdResponse,
    }, 201);
  });

  it('should handle minimal event data', async () => {
    const minimalEventData = {
      id: 'event-minimal',
      title: 'Minimal Event',
      tags: ['basic'],
    };

    const mockVector = [0.1, 0.2, 0.3];
    
    mockContext.req.json.mockResolvedValue(minimalEventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue(mockVector);

    await ingestEventRoute(mockContext);

    expect(mockIngestEndpoint).toHaveBeenCalledWith({
      ...minimalEventData,
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });

    expect(mockVectorIndex.upsert).toHaveBeenCalledWith([
      {
        id: 'event-minimal',
        vector: mockVector,
        metadata: {
          title: 'Minimal Event',
          tags: ['basic'],
          host: '',
          category: '',
          location: '',
        },
      },
    ]);
  });

  it('should fail when embedding generation returns zero vector', async () => {
    const eventData = {
      id: 'event-fail',
      title: 'Fail Event',
      tags: ['fail'],
    };

    const zeroVector = [0, 0, 0];
    
    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue(zeroVector);

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );

    expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
  });

  it('should handle TinyBird ingestion failure', async () => {
    const eventData = {
      id: 'event-tinybird-fail',
      title: 'TinyBird Fail',
      tags: ['fail'],
    };

    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    mockIngestEndpoint.mockRejectedValue(new Error('TinyBird API Error'));

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );
  });

  it('should handle vector upsert failure', async () => {
    const eventData = {
      id: 'event-vector-fail',
      title: 'Vector Fail',
      tags: ['fail'],
    };

    mockContext.req.json.mockResolvedValue(eventData);
    vi.mocked(vector.generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    mockVectorIndex.upsert.mockRejectedValue(new Error('Vector API Error'));

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );
  });

  it('should handle validation errors', async () => {
    const invalidEventData = {
      title: 'No ID Event',
    };

    mockContext.req.json.mockResolvedValue(invalidEventData);
    vi.mocked(utils.validateInput).mockImplementation(() => {
      throw new Error('Validation failed');
    });

    await ingestEventRoute(mockContext);

    expect(utils.handleError).toHaveBeenCalledWith(
      mockContext,
      expect.any(Error),
      'Failed to ingest event'
    );

    expect(mockIngestEndpoint).not.toHaveBeenCalled();
    expect(mockVectorIndex.upsert).not.toHaveBeenCalled();
  });
});