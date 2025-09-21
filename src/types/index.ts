export interface EnvBindings {
  DB: D1Database;
  CACHE: KVNamespace;
  TAG_VECTORS_KV: KVNamespace;
  VECTOR_URL: string;
  VECTOR_TOKEN: string;
  X_APP_KEY: string;
  OPENAI_API_KEY: string;
  TINYBIRD_TOKEN: string;
  TINYBIRD_BASE_URL: string;
  ENVIRONMENT?: string;
  MONITORING_ENDPOINT?: string;
  MONITORING_TOKEN?: string;
  METRICS_ENDPOINT?: string;
  METRICS_TOKEN?: string;
  ALERTS_WEBHOOK?: string;
}

export interface UserDemographics {
  country: string | null;
  interests: string[];
}

export interface Interaction {
  user_id: string;
  event_id: string;
  action: string;
  weight: number;
  timestamp: number;
}

export interface InteractionResult {
  event_id: string;
  action: string;
  weight: number;
  timestamp: string;
}

export interface VectorMetadata {
  title: string;
  tags: string[];
  host?: string;
}

export interface TagVectors {
  [key: string]: number[];
}

export interface EnrichedRecommendation {
  event_id: string;
  score: number;
  diversified: boolean;
}

export interface TemporalPattern {
  hour: number;
  day_of_week: number;
  interaction_count: number;
  like_rate: number;
}

export interface UserBehaviorProfile {
  user_id: string;
  interaction_velocity: number;
  tag_diversity: number;
  engagement_depth: number;
  preferred_times: number[];
  social_level: number;
  exploration_success_rate: number;
}

export interface ExplorationItem {
  event_id: string;
  score: number;
  exploration_type: 'temporal' | 'anti_correlated' | 'trending' | 'serendipity';
  confidence: number;
}

export type ABTestGroup = 'A' | 'B';

export interface SearchResult {
  event_id: string;
  title: string;
  tags: string[];
  score: number;
}

export interface TrendingItem {
  event_id: string;
  interaction_count: number;
  engagement_rate: number;
}

export interface UserSimilarity {
  user_id: string;
  similar_user_id: string;
  similarity_score: number;
  common_interactions: number;
  last_updated: number;
}

export interface SimilarityBatchJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  user_batch_start: string;
  user_batch_end: string;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  processed_users: number;
  total_similarities: number;
  error?: string;
}

export interface CompensationAction {
  id: string;
  type: 'rollback' | 'retry' | 'manual_intervention';
  description: string;
  payload: Record<string, unknown>;
  timestamp: number;
  status: 'pending' | 'completed' | 'failed';
  retryCount?: number;
  maxRetries?: number;
}

export interface LogContext {
  userId?: string;
  eventId?: string;
  requestId?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface MetricData {
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
  timestamp?: number;
}
