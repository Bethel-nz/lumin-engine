import { CONFIG } from '../config';

export type EmbeddingTask =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY';

export type EmbeddingPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface EmbeddingClient {
  embed(parts: EmbeddingPart[], taskType: EmbeddingTask): Promise<number[]>;
}

export interface EmbeddingEnv {
  GEMINI_API_KEY: string;
}

export const createEmbeddingClient = (env: EmbeddingEnv): EmbeddingClient => ({
  async embed(parts, taskType) {
    if (!parts.length) {
      throw new Error('embed called with no content parts');
    }

    const response = await fetch(
      `${CONFIG.EMBEDDING.BASE_URL}/models/${CONFIG.EMBEDDING.MODEL}:embedContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          content: { parts },
          outputDimensionality: CONFIG.EMBEDDING.DIMENSIONS,
          taskType,
        }),
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Gemini embedContent failed (${response.status}): ${detail.slice(0, 300)}`
      );
    }

    const payload = (await response.json()) as {
      embedding?: { values?: number[] };
    };
    const values = payload.embedding?.values;

    if (!Array.isArray(values) || values.length !== CONFIG.EMBEDDING.DIMENSIONS) {
      throw new Error(
        `Gemini returned ${values?.length ?? 'no'} dimensions, expected ${CONFIG.EMBEDDING.DIMENSIONS}`
      );
    }

    return values;
  },
});

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

export const fetchImagePart = async (
  imageUrl: string
): Promise<EmbeddingPart | null> => {
  const { TIMEOUT_MS, MAX_BYTES, ALLOWED_MIME } = CONFIG.EMBEDDING.IMAGE;

  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const mimeType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!(ALLOWED_MIME as readonly string[]).includes(mimeType)) return null;

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return null;

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null;

    return {
      inlineData: { mimeType, data: toBase64(new Uint8Array(buffer)) },
    };
  } catch {
    return null;
  }
};
