import { Index } from '@upstash/vector';
import type { Context } from 'hono';
import OpenAI from 'openai';
import type { EnvBindings } from '../types';

export const getOpenAIClient = (
  c: Context<{ Bindings: EnvBindings }>
): OpenAI => {
  return new OpenAI({ apiKey: c.env.OPENAI_API_KEY });
};

export const getVectorIndex = (
  c: Context<{ Bindings: EnvBindings }>
): Index => {
  return new Index({ url: c.env.VECTOR_URL, token: c.env.VECTOR_TOKEN });
};
