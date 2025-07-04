import { z } from 'zod';
import { CONFIG } from '../config';

export const ingestEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tags: z.array(z.string()).min(1),
  host: z.string().optional(),
});

export const logInteractionSchema = z
  .object({
    user_id: z.string().min(1),
    event_id: z.string().min(1),
    action: z
      .string()
      .refine((val) => Object.keys(CONFIG.WEIGHTS).includes(val), {
        message: 'Invalid action type',
      }),
    tags: z.array(z.string()).optional(),
  })
  .refine(
    (data) =>
      !(
        data.action === 'select_tags' &&
        (!data.tags || data.tags.length === 0)
      ),
    {
      message:
        "Tags array must be provided and non-empty for 'select_tags' action",
      path: ['tags'],
    }
  );
