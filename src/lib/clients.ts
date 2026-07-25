import { Index } from '@upstash/vector';
import type { Context } from 'hono';
import type { EnvBindings } from '../types';
import { createEmbeddingClient, type EmbeddingClient } from '../services/embedding';

export const getEmbeddingClient = (
  c: Context<{ Bindings: EnvBindings }>
): EmbeddingClient => {
  return createEmbeddingClient(c.env);
};

export const getVectorIndex = (
  c: Context<{ Bindings: EnvBindings }>
): Index => {
  return new Index({ url: c.env.VECTOR_URL, token: c.env.VECTOR_TOKEN });
};
