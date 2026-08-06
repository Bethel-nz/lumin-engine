import {
	createCatalogInteractionIngestion,
	getRecommendationTinybirdClient,
} from "../lib/recommendation-tinybird";
import type { EnvBindings } from "../types";
import type { CatalogInteractionInput } from "../validation/recommendation-schemas";

export type CatalogInteractionEvent = {
	tenantId: string;
	catalogId: string;
	interaction: CatalogInteractionInput & { id: string };
	recordedAt: number;
};

/**
 * Interaction events bypass D1. Queue retries are safe because Tinybird
 * queries deduplicate by the stable interaction ID.
 */
export const deliverCatalogInteraction = (
	env: EnvBindings,
	event: CatalogInteractionEvent,
) =>
	createCatalogInteractionIngestion(getRecommendationTinybirdClient({ env }))(
		event.tenantId,
		event.catalogId,
		event.interaction,
		event.recordedAt,
	);
