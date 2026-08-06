import type { Context } from "hono";
import {
	createCatalogAnalyticsQuery,
	createTrendingItemsQuery,
	getRecommendationTinybirdClient,
} from "../lib/recommendation-tinybird";
import type { AppVariables, EnvBindings } from "../types";

type AppContext = Context<{
	Bindings: EnvBindings;
	Variables: AppVariables;
}>;

type AnalyticsInput = {
	hours: number;
	bucketHours: number;
	topItemsLimit: number;
};

export const getCatalogAnalytics = async (
	c: AppContext,
	tenantId: string,
	catalogId: string,
	input: AnalyticsInput,
) => {
	const client = getRecommendationTinybirdClient({ env: c.env });
	const analytics = createCatalogAnalyticsQuery(client)({
		tenant_id: tenantId,
		catalog_id: catalogId,
		hours: input.hours,
		bucket_hours: input.bucketHours,
	});
	const trending = createTrendingItemsQuery(client)({
		tenant_id: tenantId,
		catalog_id: catalogId,
		hours: input.hours,
		limit: input.topItemsLimit,
		category: "",
	});

	const [seriesResult, trendingResult] = await Promise.all([
		analytics,
		trending,
	]);
	const zeroActions = {
		view: 0,
		click: 0,
		like: 0,
		save: 0,
		complete: 0,
		purchase: 0,
		dismiss: 0,
		dislike: 0,
	};
	const totals = seriesResult.data.reduce(
		(total, point) => ({
			interactions: total.interactions + point.interaction_count,
			engagement_score: total.engagement_score + point.engagement_score,
			actions: {
				view: total.actions.view + point.view_count,
				click: total.actions.click + point.click_count,
				like: total.actions.like + point.like_count,
				save: total.actions.save + point.save_count,
				complete: total.actions.complete + point.complete_count,
				purchase: total.actions.purchase + point.purchase_count,
				dismiss: total.actions.dismiss + point.dismiss_count,
				dislike: total.actions.dislike + point.dislike_count,
			},
		}),
		{ interactions: 0, engagement_score: 0, actions: zeroActions },
	);

	return {
		period: {
			hours: input.hours,
			bucket_hours: input.bucketHours,
			starts_at: Date.now() - input.hours * 3_600_000,
			ends_at: Date.now(),
		},
		totals,
		series: seriesResult.data.map((point) => ({
			timestamp: point.bucket,
			interactions: point.interaction_count,
			active_users: point.active_user_count,
			engagement_score: point.engagement_score,
			actions: {
				view: point.view_count,
				click: point.click_count,
				like: point.like_count,
				save: point.save_count,
				complete: point.complete_count,
				purchase: point.purchase_count,
				dismiss: point.dismiss_count,
				dislike: point.dislike_count,
			},
		})),
		top_items: trendingResult.data.map((item) => ({
			item_id: item.item_id,
			title: item.title,
			category: item.category,
			interactions: item.interaction_count,
			engagement_score: item.engagement_score,
		})),
	};
};
