export const CONFIG = {
  WEIGHTS: {
    click: 1,
    like: 2,
    view: 0.5,
    select_tags: 5,
    dislike: -1,
    signup: 0,
  } as const,

  EMBEDDING: {
    MODEL: 'text-embedding-3-large',
    DIMENSIONS: 3072,
  } as const,

  CACHE_TTL: {
    RECOMMENDATIONS: 1800, // 30 minutes
    USER_TAGS: 2592000, // 30 days
    AB_GROUP: 2592000, // 30 days
    EXPLORATION_TRACKING: 7 * 24 * 60 * 60, // 7 days
  } as const,

  RATE_LIMITS: {
    GLOBAL: {
      windowMs: 15 * 60 * 1000,
      limit: 100,
    },
    USER: {
      windowMs: 15 * 60 * 1000,
      limit: 50,
    },
  } as const,

  ALLOWED_ORIGINS: ['http://localhost:3000', 'https://synaxis-app.vercel.app'],

  AB_TEST_CONFIG: {
    GROUP_A: {
      initialTopK: 40,
      useDiversification: true,
    },
    GROUP_B: {
      initialTopK: 50,
      useDiversification: false,
    },
  } as const,

  EXPLORATION: {
    BASE_RATE: 0.4,
    MIN_RATE: 0.1,
    MAX_RATE: 0.6,
    RATE_DECAY_PER_INTERACTION: 0.01,
    LOW_ENGAGEMENT_MULTIPLIER: 2,
    LOW_ENGAGEMENT_THRESHOLD: 0.3,
    INJECTION_SLOTS: [2, 5, 8],
  } as const,
} as const;
