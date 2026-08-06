import { getCatalogVectorIndex } from "../lib/clients";
import {
	createItemIngestion,
	getRecommendationTinybirdClient,
} from "../lib/recommendation-tinybird";
import type { EnvBindings } from "../types";
import type { CatalogItemInput } from "../validation/recommendation-schemas";

const MAX_ATTEMPTS = 5;
const CLAIM_TIMEOUT_MS = 5 * 60_000;

type ItemPayload = {
	kind: "item_upsert";
	item: CatalogItemInput;
	embedding: number[];
	indexedAt: number;
};

type CatalogOutboxPayload = ItemPayload;

type OutboxRow = {
	id: string;
	kind: CatalogOutboxPayload["kind"];
	tenant_id: string;
	catalog_id: string;
	payload: string;
	attempts: number;
};

const itemStatement = (
	db: D1Database,
	tenantId: string,
	catalogId: string,
	item: CatalogItemInput,
	now: number,
) =>
	db
		.prepare(
			`INSERT INTO catalog_items
       (tenant_id, catalog_id, item_id, title, description, tags, category,
        image_url, price, attributes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, catalog_id, item_id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         tags = excluded.tags,
         category = excluded.category,
         image_url = excluded.image_url,
         price = excluded.price,
         attributes = excluded.attributes,
         updated_at = excluded.updated_at`,
		)
		.bind(
			tenantId,
			catalogId,
			item.item_id,
			item.title,
			item.description ?? null,
			JSON.stringify(item.tags),
			item.category ?? null,
			item.image_url ?? null,
			item.price ?? null,
			JSON.stringify(item.attributes),
			now,
			now,
		);

const outboxStatement = (
	db: D1Database,
	id: string,
	tenantId: string,
	catalogId: string,
	payload: CatalogOutboxPayload,
	now: number,
) =>
	db
		.prepare(
			`INSERT INTO catalog_outbox
       (id, kind, tenant_id, catalog_id, payload, status, attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
		)
		.bind(
			id,
			payload.kind,
			tenantId,
			catalogId,
			JSON.stringify(payload),
			now,
			now,
		);

export const persistCatalogItemWithOutbox = async (
	db: D1Database,
	tenantId: string,
	catalogId: string,
	item: CatalogItemInput,
	embedding: number[],
	now: number,
) => {
	const outboxId = `item:${tenantId}:${catalogId}:${item.item_id}:${now}`;
	await db.batch([
		itemStatement(db, tenantId, catalogId, item, now),
		outboxStatement(
			db,
			outboxId,
			tenantId,
			catalogId,
			{
				kind: "item_upsert",
				item,
				embedding,
				indexedAt: now,
			},
			now,
		),
	]);
	return outboxId;
};

const claimNext = async (db: D1Database): Promise<OutboxRow | null> => {
	const now = Date.now();
	const staleClaim = now - CLAIM_TIMEOUT_MS;
	const row = await db
		.prepare(
			`SELECT id, kind, tenant_id, catalog_id, payload, attempts
       FROM catalog_outbox
       WHERE (status = 'pending' AND available_at <= ?)
          OR (status = 'processing' AND claimed_at < ?)
       ORDER BY created_at ASC
       LIMIT 1`,
		)
		.bind(now, staleClaim)
		.first<OutboxRow>();

	if (!row) return null;

	const claim = await db
		.prepare(
			`UPDATE catalog_outbox
       SET status = 'processing', claimed_at = ?, attempts = attempts + 1
       WHERE id = ?
         AND (
           (status = 'pending' AND available_at <= ?)
           OR (status = 'processing' AND claimed_at < ?)
         )`,
		)
		.bind(now, row.id, now, staleClaim)
		.run();

	return claim.meta.changes === 1
		? { ...row, attempts: row.attempts + 1 }
		: null;
};

// Successful work no longer needs a durable receipt. Deleting it keeps the
// outbox proportional to outstanding delivery failures instead of lifetime
// interaction volume.
const markCompleted = (db: D1Database, id: string) =>
	db.prepare("DELETE FROM catalog_outbox WHERE id = ?").bind(id).run();

const markFailed = (db: D1Database, row: OutboxRow, error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	const terminal = row.attempts >= MAX_ATTEMPTS;
	const delayMs = Math.min(
		60_000 * 2 ** Math.max(row.attempts - 1, 0),
		60 * 60_000,
	);
	return db
		.prepare(
			`UPDATE catalog_outbox
       SET status = ?, claimed_at = NULL, available_at = ?, last_error = ?
       WHERE id = ?`,
		)
		.bind(
			terminal ? "failed" : "pending",
			Date.now() + delayMs,
			message,
			row.id,
		)
		.run();
};

const deliver = async (env: EnvBindings, row: OutboxRow) => {
	const payload = JSON.parse(row.payload) as CatalogOutboxPayload;
	const context = { env };
	const tinybird = getRecommendationTinybirdClient(context);

	if (payload.kind === "item_upsert") {
		await Promise.all([
			getCatalogVectorIndex(context, row.tenant_id, row.catalog_id).upsert([
				{
					id: payload.item.item_id,
					vector: payload.embedding,
					metadata: {
						item_id: payload.item.item_id,
						title: payload.item.title,
						description: payload.item.description ?? "",
						tags: payload.item.tags,
						category: payload.item.category ?? "",
						image_url: payload.item.image_url ?? "",
						price: payload.item.price ?? 0,
						attributes: payload.item.attributes,
					},
				},
			]),
			createItemIngestion(tinybird)(
				row.tenant_id,
				row.catalog_id,
				payload.item,
				payload.indexedAt,
			),
		]);
		return;
	}

};

/**
 * Processes a bounded number of durable derived writes. Failures remain in D1
 * with backoff, so callers can return after the source record is safe.
 */
export const drainCatalogOutbox = async (
	env: EnvBindings,
	limit = 10,
): Promise<{ completed: number; deferred: number }> => {
	let completed = 0;
	let deferred = 0;

	for (let index = 0; index < limit; index += 1) {
		const row = await claimNext(env.DB);
		if (!row) break;

		try {
			await deliver(env, row);
			await markCompleted(env.DB, row.id);
			completed += 1;
		} catch (error) {
			await markFailed(env.DB, row, error);
			deferred += 1;
		}
	}

	return { completed, deferred };
};
