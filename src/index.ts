import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { cors } from 'hono/cors';
import { CONFIG } from './config';
import { getAuth, getTrustedOrigins } from './lib/auth';
import { requireApiKey } from './middleware/auth';
import {
  createCatalogRoute,
  getCatalogRoute,
  listCatalogsRoute,
} from './routes/catalogs';
import { requireCatalog, resolveTenant } from './middleware/tenant';
import {
  getCatalogItemRoute,
  getCatalogAnalyticsRoute,
  ingestCatalogItemRoute,
  listCatalogItemsRoute,
  logCatalogInteractionRoute,
  recommendCatalogItemsRoute,
  searchCatalogRoute,
} from './routes/recommendation-api';
import type { AppVariables, EnvBindings } from './types';
import { drainCatalogOutbox } from './services/catalog-outbox';
import {
  deliverCatalogInteraction,
  type CatalogInteractionEvent,
} from './services/catalog-interaction-events';

export const app = new Hono<{ Bindings: EnvBindings; Variables: AppVariables }>();

// CORS middleware
app.use(
  '*',
  cors({
    origin: (origin, c) =>
      getTrustedOrigins(c.env.BETTER_AUTH_TRUSTED_ORIGINS).includes(origin)
        ? origin
        : null,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'X-Lumin-Key',
      'X-App-Key',
      'X-Api-Key',
      'Authorization',
    ],
    credentials: true,
  })
);

type AppEnv = { Bindings: EnvBindings; Variables: AppVariables };
type Limiter = MiddlewareHandler<AppEnv>;

const lazyLimiter = (create: () => Limiter): Limiter => {
  let limiter: Limiter | undefined;
  return (c, next) => {
    limiter ??= create();
    return limiter(c, next);
  };
};

const globalRateLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: CONFIG.RATE_LIMITS.GLOBAL.windowMs,
    limit: CONFIG.RATE_LIMITS.GLOBAL.limit,
    keyGenerator: (c) =>
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For') ||
      'ip_unknown',
    message: () => ({
      error:
        'Too many requests from this IP, please try again after 15 minutes',
    }),
  })
);

const userRateLimiter = lazyLimiter(() =>
  rateLimiter({
    windowMs: CONFIG.RATE_LIMITS.USER.windowMs,
    limit: CONFIG.RATE_LIMITS.USER.limit,
    keyGenerator: (c) => c.req.param('userId') || 'user_unknown',
    message: () => ({
      error:
        'Too many requests for this user, please try again after 15 minutes',
    }),
  })
);

const isLocalDevelopmentRequest = (
  c: Parameters<Limiter>[0]
): boolean => {
  if (c.env.ENVIRONMENT !== 'development') return false;

  const hostname = new URL(c.req.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
};

app.use('*', (c, next) =>
  isLocalDevelopmentRequest(c) ? next() : globalRateLimiter(c, next)
);

// Better Auth endpoints
app.on(['POST', 'GET'], '/api/auth/*', (c) => {
  const auth = getAuth(c.env.DB, c.env);
  return auth.handler(c.req.raw);
});

// Public routes
app.get('/', (c) => c.text('Welcome to Lumin Recommendation Service!'));

app.post('/api/catalogs', requireApiKey, resolveTenant, createCatalogRoute);
app.get('/api/catalogs', requireApiKey, resolveTenant, listCatalogsRoute);
app.get(
  '/api/catalogs/:catalogId',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  getCatalogRoute
);

app.post(
  '/api/catalogs/:catalogId/items',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  ingestCatalogItemRoute
);
app.get(
  '/api/catalogs/:catalogId/items',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  listCatalogItemsRoute
);
app.get(
  '/api/catalogs/:catalogId/items/:itemId',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  getCatalogItemRoute
);
app.post(
  '/api/catalogs/:catalogId/interactions',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  logCatalogInteractionRoute
);
app.get(
  '/api/catalogs/:catalogId/search',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  searchCatalogRoute
);
app.get(
  '/api/catalogs/:catalogId/analytics',
  requireApiKey,
  resolveTenant,
  requireCatalog,
  getCatalogAnalyticsRoute
);
app.get(
  '/api/catalogs/:catalogId/users/:userId/recommendations',
  requireApiKey,
  userRateLimiter,
  resolveTenant,
  requireCatalog,
  recommendCatalogItemsRoute
);

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: EnvBindings, ctx: ExecutionContext) => {
    ctx.waitUntil(drainCatalogOutbox(env, 50));
  },
  queue: async (
    batch: MessageBatch<CatalogInteractionEvent>,
    env: EnvBindings
  ) => {
    for (const message of batch.messages) {
      try {
        await deliverCatalogInteraction(env, message.body);
        message.ack();
      } catch (error) {
        console.error('Failed to deliver catalog interaction', {
          interactionId: message.body.interaction.id,
          error,
        });
        message.retry();
      }
    }
  },
};
