import { Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { cors } from 'hono/cors';
import { CONFIG } from './config';
import { getAuth, getOrCreateAdminUser } from './lib/auth';
import { requireApiKey } from './middleware/auth';
import {
  createCatalogRoute,
  getCatalogRoute,
  listCatalogsRoute,
} from './routes/catalogs';
import { requireCatalog, resolveTenant } from './middleware/tenant';
import {
  getCatalogItemRoute,
  ingestCatalogItemRoute,
  listCatalogItemsRoute,
  logCatalogInteractionRoute,
  recommendCatalogItemsRoute,
  searchCatalogRoute,
} from './routes/recommendation-api';
import type { AppVariables, EnvBindings } from './types';

export const app = new Hono<{ Bindings: EnvBindings; Variables: AppVariables }>();

// CORS middleware
app.use(
  '*',
  cors({
    origin: ['http://localhost:3000', 'https://synaxis-app.vercel.app'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-App-Key', 'X-Api-Key', 'Authorization'],
    credentials: true,
  })
);

type Limiter = ReturnType<typeof rateLimiter>;

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

app.use('*', globalRateLimiter);

// Better Auth endpoints
app.on(['POST', 'GET'], '/api/auth/*', (c) => {
  const auth = getAuth(c.env.DB);
  return auth.handler(c.req.raw);
});

// One-time admin seed: creates the first admin user + API key
app.post('/api/admin/seed', async (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return c.json({ error: 'Not found' }, 404);
  }

  const auth = getAuth(c.env.DB);
  const adminUserId = await getOrCreateAdminUser(c.env.DB);

  const existing = await c.env.DB.prepare(
    'SELECT id FROM `apikey` WHERE reference_id = ? LIMIT 1'
  )
    .bind(adminUserId)
    .first<{ id: string }>();

  const key = await auth.api.createApiKey({
    body: {
      userId: adminUserId,
      name: existing ? `local-demo-${Date.now()}` : 'admin-key',
      expiresIn: null,
    },
  });

  return c.json({
    message: existing
      ? 'A new local demo key was created.'
      : 'Admin seeded successfully',
    adminUserId,
    apiKey: key.key,
    warning: 'Store this key securely. It will not be shown again.',
  });
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
  '/api/catalogs/:catalogId/users/:userId/recommendations',
  requireApiKey,
  userRateLimiter,
  resolveTenant,
  requireCatalog,
  recommendCatalogItemsRoute
);

export default app;
