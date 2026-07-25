import type { Context } from 'hono';
import { insertInteraction, upsertUserProfile } from '../services/database';
import { getTinybirdClient, createInteractionIngestionEndpoint } from '../lib/tinybird';
import type { EnvBindings } from '../types';
import { handleError, withRetry } from '../utils';
import { logInteractionSchema } from '../validation/tinybird-schemas';

export const logInteractionRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  try {
    const body = await c.req.json();
    const interactionData = logInteractionSchema.parse(body);
    const { id, user_id, event_id, action, tags } = interactionData;

    const tb = getTinybirdClient(c);
    const ingestInteraction = createInteractionIngestionEndpoint(tb);

    await upsertUserProfile(c.env.DB, user_id);

    if (action !== 'select_tags' && action !== 'signup') {
      await insertInteraction(c.env.DB, {
        id,
        user_id,
        event_id,
        action,
        timestamp: Date.now(),
      });
    }

    await withRetry(() => ingestInteraction(interactionData));

    if (action === 'select_tags' && tags) {
      await c.env.CACHE.put(`user_tags:${user_id}`, JSON.stringify(tags), {
        expirationTtl: 2592000,
      });
    }

    await c.env.CACHE.delete(`recs:${user_id}`);
    await c.env.CACHE.delete(`recs_hash:${user_id}`);

    return c.json(
      {
        success: true,
        interaction_id: id,
        message: `Interaction logged for user ${user_id}`,
      },
      201
    );
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to log interaction');
  }
};
