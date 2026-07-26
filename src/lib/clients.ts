import { Index } from '@upstash/vector';
import type { EnvBindings } from '../types';
import { createEmbeddingClient, type EmbeddingClient } from '../services/embedding';

export const getEmbeddingClient = (
  c: { env: EnvBindings }
): EmbeddingClient => {
  return createEmbeddingClient(c.env);
};

export const getVectorIndex = (
  c: { env: EnvBindings }
): Index => {
  return new Index({ url: c.env.VECTOR_URL, token: c.env.VECTOR_TOKEN });
};

export const getCatalogVectorIndex = (
  c: { env: EnvBindings },
  tenantId: string,
  catalogId: string
) => getVectorIndex(c).namespace(`${tenantId}:${catalogId}`);
