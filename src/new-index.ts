import { Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { cors } from 'hono/cors';
import { ingestEventRoute } from './routes/events';
import { logInteractionRoute } from './routes/interactions';
import { getRecommendationsRoute } from './routes/recommendations';
import { searchRoute } from './routes/search';
import { scheduledTagVectorUpdate } from './services/scheduled';
import type { EnvBindings } from './types';

const app = new Hono<{ Bindings: EnvBindings }>();

// CORS middleware
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowedWebOrigins = [
        'http://localhost:3000',
        'https://synaxis-app.vercel.app',
      ];
      const appKey = c.req.header('X-App-Key');
      if (appKey && appKey === c.env.X_APP_KEY) {
        return origin;
      }
      return allowedWebOrigins.includes(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-App-Key', 'Authorization'],
    credentials: true,
  })
);

// Rate limiting
app.use(
  '*',
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 100,
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

const userRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  keyGenerator: (c) => c.req.param('userId') || 'user_unknown',
  message: () => ({
    error: 'Too many requests for this user, please try again after 15 minutes',
  }),
});

// Routes
app.get('/', (c) => c.text('Welcome to Lumin Recommendation Service!'));

app.get(
  '/get-recommendations/:userId',
  userRateLimiter,
  getRecommendationsRoute
);
app.post('/ingest-event', ingestEventRoute);
app.post('/log-interactions', logInteractionRoute);
app.get('/search', searchRoute);

export default {
  fetch: app.fetch,
  scheduled: async (
    controller: ScheduledController,
    env: EnvBindings,
    ctx: ExecutionContext
  ): Promise<void> => {
    if (controller.cron === '*/30 * * * *') {
      // Update tag vectors every 30 minutes
      await scheduledTagVectorUpdate(env, ctx);
    }
  },
};
