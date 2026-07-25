import type { Index } from '@upstash/vector';
import type { IngestEvent } from '../validation/tinybird-schemas';

export const upsertEventVector = (
  vectorIndex: Index,
  eventData: IngestEvent,
  vector: number[]
) =>
  vectorIndex.upsert([
    {
      id: eventData.id,
      vector,
      metadata: {
        title: eventData.title,
        tags: eventData.tags,
        host: eventData.host ?? '',
        category: eventData.category ?? '',
        image_url: eventData.image_url ?? '',
        location: eventData.location ?? '',
      },
    },
  ]);

export const persistEventToD1 = (
  db: D1Database,
  eventData: IngestEvent
) => {
  const metadata = JSON.stringify({
    title: eventData.title,
    host: eventData.host,
    category: eventData.category,
    location: eventData.location,
  });
  const statements = [
    db.prepare(
      `INSERT INTO events (id, metadata)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET
         metadata = excluded.metadata,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(eventData.id, metadata),
    db.prepare('DELETE FROM event_tags WHERE event_id = ?').bind(eventData.id),
    ...eventData.tags.map((tag) =>
      db
        .prepare(
          `INSERT INTO event_tags (event_id, tag)
           VALUES (?, ?)
           ON CONFLICT(event_id, tag) DO NOTHING`
        )
        .bind(eventData.id, tag)
    ),
  ];

  return db.batch(statements);
};
