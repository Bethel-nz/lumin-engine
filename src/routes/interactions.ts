import type { Context } from 'hono';
import { checkUserExists, insertInteraction } from '../services/database';
import type { EnvBindings } from '../types';
import { handleError, validateInput } from '../utils';
import { logInteractionSchema } from '../validation/schemas';

export const logInteractionRoute = async (
  c: Context<{ Bindings: EnvBindings }>
) => {
  try {
    const body = await c.req.json();
    const interactionData = validateInput(body, logInteractionSchema);
    const { user_id, event_id, action, tags } = interactionData;

    const userExists = await checkUserExists(c.env.DB, user_id);
    if (!userExists) {
      await insertInteraction(c.env.DB, {
        user_id,
        event_id: 'initial_signup',
        action: 'signup',
        timestamp: Date.now(),
      });
    }

    await insertInteraction(c.env.DB, {
      user_id,
      event_id,
      action,
      timestamp: Date.now(),
    });

    if (action === 'select_tags' && tags) {
      await c.env.CACHE.put(`user_tags:${user_id}`, JSON.stringify(tags), {
        expirationTtl: 2592000,
      });
    }

    // Clear recommendation cache for this user
    await c.env.CACHE.delete(`recs:${user_id}`);
    await c.env.CACHE.delete(`recs_hash:${user_id}`);

    return c.json(
      { success: true, message: `Interaction logged for user ${user_id}` },
      201
    );
  } catch (e: unknown) {
    return handleError(c, e, 'Failed to log interaction');
  }
};
