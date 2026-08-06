import { createLocalApiKey } from './local-auth';

type EvaluationCluster =
  | 'science-fiction'
  | 'romance'
  | 'horror'
  | 'family';

interface EvaluationItem {
  item_id: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  attributes: {
    eval_cluster: EvaluationCluster;
  };
}

interface Recommendation {
  item_id: string;
  title: string;
  score: number;
  attributes?: {
    eval_cluster?: EvaluationCluster;
  };
}

interface RecommendationResponse {
  recommendations: Recommendation[];
  metadata: {
    strategy: 'popular' | 'personalized';
    learned_from_interactions: number;
  };
}

interface ProfileResult {
  profile: EvaluationCluster;
  user_id: string;
  strategy: string;
  learned_from_interactions: number;
  precision_at_5: number;
  target_hits: number;
  seen_item_leakage: string[];
  stable_ranking: boolean;
  ranking_survives_duplicate_delivery: boolean;
  differs_from_cold_start: boolean;
  top_5: Array<{
    item_id: string;
    title: string;
    cluster: string;
    score: number;
  }>;
}

const baseUrl = process.env.LUMIN_BASE_URL ?? 'http://localhost:8787';
const shouldReseed = process.argv.includes('--reseed');
const catalogName = 'recommendation-evaluation-v1';
const topK = 5;

const request = async <T>(
  path: string,
  init: RequestInit = {},
  apiKey?: string
): Promise<{ response: Response; body: T }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T;
  return { response, body };
};

const requireSuccess = <T>(
  label: string,
  result: { response: Response; body: T },
  expected: number[] = [200]
): T => {
  if (!expected.includes(result.response.status)) {
    throw new Error(
      `${label} failed with ${result.response.status}: ${JSON.stringify(result.body)}`
    );
  }
  return result.body;
};

const item = (
  cluster: EvaluationCluster,
  slug: string,
  title: string,
  description: string,
  tags: string[]
): EvaluationItem => ({
  item_id: `eval-${cluster}-${slug}`,
  title,
  description,
  tags,
  category: cluster,
  attributes: { eval_cluster: cluster },
});

const evaluationItems: EvaluationItem[] = [
  item(
    'science-fiction',
    'signal-horizon',
    'Signal Horizon',
    'Astronauts follow an alien transmission beyond the edge of the solar system.',
    ['space', 'astronauts', 'aliens', 'future']
  ),
  item(
    'science-fiction',
    'mars-protocol',
    'The Mars Protocol',
    'Engineers race to repair the first Mars colony after its artificial intelligence locks them outside.',
    ['mars', 'technology', 'artificial-intelligence', 'survival']
  ),
  item(
    'science-fiction',
    'quantum-drift',
    'Quantum Drift',
    'A physicist becomes trapped between parallel timelines while testing a quantum engine.',
    ['quantum', 'parallel-worlds', 'science', 'time']
  ),
  item(
    'science-fiction',
    'neon-orbit',
    'Neon Orbit',
    'A cybernetic courier uncovers a conspiracy aboard a crowded orbital city.',
    ['cyberpunk', 'space-station', 'androids', 'conspiracy']
  ),
  item(
    'science-fiction',
    'last-starship',
    'The Last Starship',
    'Humanity sends one final interstellar crew to search for a habitable world.',
    ['starship', 'deep-space', 'exploration', 'future']
  ),
  item(
    'science-fiction',
    'memory-machine',
    'The Memory Machine',
    'A neuroscientist discovers that a device can recover memories from alternate futures.',
    ['memory', 'technology', 'alternate-future', 'science']
  ),
  item(
    'science-fiction',
    'lunar-silence',
    'Lunar Silence',
    'A moon-base researcher investigates why every communication from Earth suddenly stopped.',
    ['moon', 'mystery', 'space', 'isolation']
  ),
  item(
    'science-fiction',
    'gravity-thieves',
    'Gravity Thieves',
    'A crew of space smugglers steals experimental technology that can bend gravity.',
    ['space-opera', 'heist', 'technology', 'adventure']
  ),

  item(
    'romance',
    'letters-in-spring',
    'Letters in Spring',
    'Two old friends reconnect through handwritten letters and slowly fall in love.',
    ['love', 'letters', 'friendship', 'spring']
  ),
  item(
    'romance',
    'paris-after-rain',
    'Paris After Rain',
    'A baker and a travel photographer meet during a rainy week in Paris.',
    ['paris', 'love', 'bakery', 'travel']
  ),
  item(
    'romance',
    'second-first-date',
    'Second First Date',
    'Former college sweethearts meet again and try to rebuild the relationship they abandoned.',
    ['relationship', 'reunion', 'love', 'second-chance']
  ),
  item(
    'romance',
    'summer-bookshop',
    'The Summer Bookshop',
    'A novelist falls for the owner of a quiet seaside bookshop.',
    ['books', 'seaside', 'love', 'summer']
  ),
  item(
    'romance',
    'wedding-season',
    'Wedding Season',
    'Two strangers pretend to be a couple through a summer of family weddings.',
    ['wedding', 'comedy', 'relationship', 'family']
  ),
  item(
    'romance',
    'midnight-train',
    'The Midnight Train',
    'Two passengers share their lives during an overnight journey across Europe.',
    ['train', 'conversation', 'love', 'europe']
  ),
  item(
    'romance',
    'songs-for-ada',
    'Songs for Ada',
    'A reserved pianist writes a series of songs for the singer next door.',
    ['music', 'piano', 'love', 'neighbours']
  ),
  item(
    'romance',
    'coastal-promise',
    'A Coastal Promise',
    'Childhood friends return to their hometown and confront feelings they never admitted.',
    ['coast', 'childhood-friends', 'homecoming', 'love']
  ),

  item(
    'horror',
    'house-within',
    'The House Within',
    'A family discovers another house hidden inside the walls of their new home.',
    ['haunted-house', 'ghosts', 'family', 'supernatural']
  ),
  item(
    'horror',
    'whispering-woods',
    'The Whispering Woods',
    'Campers hear voices in the forest repeating secrets no stranger should know.',
    ['forest', 'supernatural', 'terror', 'survival']
  ),
  item(
    'horror',
    'room-thirteen',
    'Room Thirteen',
    'A hotel clerk investigates a room that appears only after midnight.',
    ['hotel', 'ghost', 'midnight', 'mystery']
  ),
  item(
    'horror',
    'beneath-the-lake',
    'Beneath the Lake',
    'Divers awaken an ancient creature buried beneath a flooded town.',
    ['monster', 'underwater', 'creature', 'dark']
  ),
  item(
    'horror',
    'empty-faces',
    'Empty Faces',
    'Residents of a small town begin returning home without their identities.',
    ['body-horror', 'small-town', 'identity', 'paranoia']
  ),
  item(
    'horror',
    'the-night-nurse',
    'The Night Nurse',
    'A hospital nurse realizes that the patients on one ward died decades ago.',
    ['hospital', 'ghosts', 'night', 'supernatural']
  ),
  item(
    'horror',
    'red-harvest',
    'Red Harvest',
    'A rural community is stalked by something that emerges during the autumn harvest.',
    ['rural', 'creature', 'folk-horror', 'autumn']
  ),
  item(
    'horror',
    'last-broadcast',
    'The Last Broadcast',
    'A radio host receives calls describing murders minutes before they happen.',
    ['radio', 'serial-killer', 'suspense', 'night']
  ),

  item(
    'family',
    'cloud-circus',
    'The Cloud Circus',
    'Young acrobats travel in a magical circus floating above the clouds.',
    ['animation', 'magic', 'adventure', 'friendship']
  ),
  item(
    'family',
    'robot-puppy',
    'My Robot Puppy',
    'Two siblings build a playful robot dog who helps save their neighbourhood.',
    ['animation', 'children', 'robot', 'comedy']
  ),
  item(
    'family',
    'dragon-school',
    'Dragon School',
    'A shy child enrols in a school where young dragons learn to fly.',
    ['animation', 'dragons', 'school', 'friendship']
  ),
  item(
    'family',
    'moonlight-garden',
    'The Moonlight Garden',
    'A girl discovers that the animals in her grandmother’s garden talk at night.',
    ['animals', 'magic', 'family', 'adventure']
  ),
  item(
    'family',
    'little-inventors',
    'The Little Inventors',
    'A group of children enters a science fair with a machine that brings drawings to life.',
    ['children', 'invention', 'comedy', 'teamwork']
  ),
  item(
    'family',
    'penguin-parade',
    'Penguin Parade',
    'A lost penguin and a young explorer cross the ice to find their families.',
    ['animation', 'animals', 'adventure', 'family']
  ),
  item(
    'family',
    'castle-of-kites',
    'The Castle of Kites',
    'Friends follow a magical kite into a kingdom hidden above their city.',
    ['fantasy', 'children', 'friendship', 'adventure']
  ),
  item(
    'family',
    'grandmas-spaceship',
    'Grandma’s Spaceship',
    'Three cousins learn that their grandmother was once a famous space explorer.',
    ['family', 'comedy', 'space', 'children']
  ),
];

const catalogDefinition = {
  name: catalogName,
  fields: [{ name: 'eval_cluster', type: 'string' }],
  embed_config: {
    // eval_cluster is deliberately excluded. The label is ground truth for
    // evaluation, not a shortcut supplied to the embedding model.
    text_fields: ['title', 'description', 'tags', 'category'],
  },
};

const getApiKey = async () => {
  if (process.env.LUMIN_API_KEY) return process.env.LUMIN_API_KEY;
  return (await createLocalApiKey(baseUrl, 'recommendation evaluator')).apiKey;
};

const getOrCreateCatalog = async (apiKey: string) => {
  const created = await request<{ catalog_id?: string; error?: string }>(
    '/api/catalogs',
    {
      method: 'POST',
      body: JSON.stringify(catalogDefinition),
    },
    apiKey
  );

  if (created.response.status === 201 && created.body.catalog_id) {
    return created.body.catalog_id;
  }
  if (created.response.status !== 409) {
    requireSuccess('Evaluation catalog creation', created, [201]);
  }

  const listed = await request<{
    catalogs?: Array<{ catalog_id: string; name: string }>;
  }>('/api/catalogs', {}, apiKey);
  const found = requireSuccess('Catalog listing', listed).catalogs?.find(
    (catalog) => catalog.name === catalogName
  );
  if (!found) {
    throw new Error('Evaluation catalog exists but could not be resolved.');
  }
  return found.catalog_id;
};

const seedCatalog = async (apiKey: string, catalogId: string) => {
  const listed = await request<{ items?: Array<{ item_id: string }> }>(
    // Must exceed evaluationItems.length, or the existing set silently
    // truncates and every run re-ingests the whole catalog.
    `/api/catalogs/${catalogId}/items?limit=${evaluationItems.length + 50}`,
    {},
    apiKey
  );
  const existing = new Set(
    (requireSuccess('Evaluation item listing', listed).items ?? []).map(
      (entry) => entry.item_id
    )
  );
  const pending = shouldReseed
    ? evaluationItems
    : evaluationItems.filter((entry) => !existing.has(entry.item_id));

  for (const [index, entry] of pending.entries()) {
    const ingested = await request(
      `/api/catalogs/${catalogId}/items`,
      {
        method: 'POST',
        body: JSON.stringify(entry),
      },
      apiKey
    );
    requireSuccess(`Ingest ${entry.item_id}`, ingested, [201]);
    process.stdout.write(
      `\rIndexed ${index + 1}/${pending.length} evaluation items`
    );
  }
  if (pending.length > 0) process.stdout.write('\n');

  return {
    existing: existing.size,
    indexed: pending.length,
    total: evaluationItems.length,
  };
};

const getRecommendations = async (
  apiKey: string,
  catalogId: string,
  userId: string
) => {
  const result = await request<RecommendationResponse>(
    `/api/catalogs/${catalogId}/users/${encodeURIComponent(userId)}/recommendations?limit=10`,
    {},
    apiKey
  );
  return requireSuccess(`Recommendations for ${userId}`, result);
};

const recordInteraction = async (
  apiKey: string,
  catalogId: string,
  input: {
    id: string;
    user_id: string;
    item_id: string;
    action: 'like';
    session_id: string;
    source: string;
  }
) => {
  const result = await request(
    `/api/catalogs/${catalogId}/interactions`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    apiKey
  );
  requireSuccess(`Interaction ${input.id}`, result, [201]);
};

const rankingOf = (response: RecommendationResponse) =>
  response.recommendations.map((entry) => entry.item_id).join('|');

const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((entry) => b.has(entry)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
};

const run = async () => {
  const apiKey = await getApiKey();
  const catalogId = await getOrCreateCatalog(apiKey);
  const seeded = await seedCatalog(apiKey, catalogId);
  const runId = crypto.randomUUID().slice(0, 8);
  const coldUserId = `eval-${runId}-cold`;
  const cold = await getRecommendations(apiKey, catalogId, coldUserId);
  const coldRanking = rankingOf(cold);

  // A second untrained user. Popular is user-independent, so two cold users
  // must receive the same ranking; a personalized user must not.
  const secondColdUserId = `eval-${runId}-cold-b`;
  const secondCold = await getRecommendations(
    apiKey,
    catalogId,
    secondColdUserId
  );
  const profiles = (
    ['science-fiction', 'romance', 'horror', 'family'] as EvaluationCluster[]
  ).map((cluster) => ({
    cluster,
    userId: `eval-${runId}-${cluster}`,
    liked: evaluationItems
      .filter((entry) => entry.attributes.eval_cluster === cluster)
      .slice(0, 3),
  }));

  const profileResults: ProfileResult[] = [];

  for (const profile of profiles) {
    const sessionId = `eval-session-${runId}-${profile.cluster}`;
    const interactions = profile.liked.map((entry, index) => ({
      id: `eval-interaction-${runId}-${profile.cluster}-${index}`,
      user_id: profile.userId,
      item_id: entry.item_id,
      action: 'like' as const,
      session_id: sessionId,
      source: 'live-evaluation',
    }));

    for (const interaction of interactions) {
      await recordInteraction(apiKey, catalogId, interaction);
    }

    // Ranking before the replay. learned_from_interactions is the engine
    // reporting on itself, so it stays green if the count is DISTINCT while
    // the vector builder sums weights over every row. Comparing the ranking
    // either side of a duplicate delivery tests the arithmetic instead.
    const beforeReplay = await getRecommendations(
      apiKey,
      catalogId,
      profile.userId
    );

    // Replay the first event with the same ID. The recommendation profile
    // should still learn from three unique records rather than four deliveries.
    await recordInteraction(apiKey, catalogId, interactions[0]);

    const first = await getRecommendations(
      apiKey,
      catalogId,
      profile.userId
    );
    const second = await getRecommendations(
      apiKey,
      catalogId,
      profile.userId
    );
    const top = first.recommendations.slice(0, topK);
    const likedIds = new Set(profile.liked.map((entry) => entry.item_id));
    const targetHits = top.filter(
      (entry) => entry.attributes?.eval_cluster === profile.cluster
    ).length;

    profileResults.push({
      profile: profile.cluster,
      user_id: profile.userId,
      strategy: first.metadata.strategy,
      learned_from_interactions:
        first.metadata.learned_from_interactions,
      precision_at_5: targetHits / topK,
      target_hits: targetHits,
      // Every returned item, not just the scored top five - exclusion is most
      // likely to fail further down the list as interaction counts grow.
      seen_item_leakage: first.recommendations
        .filter((entry) => likedIds.has(entry.item_id))
        .map((entry) => entry.item_id),
      stable_ranking: rankingOf(first) === rankingOf(second),
      ranking_survives_duplicate_delivery:
        rankingOf(beforeReplay) === rankingOf(first),
      differs_from_cold_start: rankingOf(first) !== coldRanking,
      top_5: top.map((entry) => ({
        item_id: entry.item_id,
        title: entry.title,
        cluster: entry.attributes?.eval_cluster ?? 'unknown',
        score: entry.score,
      })),
    });
  }

  const overlaps: Array<{
    profiles: string;
    top_5_jaccard: number;
  }> = [];
  for (let left = 0; left < profileResults.length; left += 1) {
    for (let right = left + 1; right < profileResults.length; right += 1) {
      overlaps.push({
        profiles: `${profileResults[left].profile} vs ${profileResults[right].profile}`,
        top_5_jaccard: jaccard(
          profileResults[left].top_5.map((entry) => entry.item_id),
          profileResults[right].top_5.map((entry) => entry.item_id)
        ),
      });
    }
  }

  const correctnessChecks = {
    cold_start_uses_popular: cold.metadata.strategy === 'popular',
    all_profiles_personalized: profileResults.every(
      (profile) => profile.strategy === 'personalized'
    ),
    duplicate_delivery_does_not_duplicate_profile_signal: profileResults.every(
      (profile) => profile.learned_from_interactions === 3
    ),
    duplicate_delivery_does_not_move_ranking: profileResults.every(
      (profile) => profile.ranking_survives_duplicate_delivery
    ),
    no_seen_items_recommended: profileResults.every(
      (profile) => profile.seen_item_leakage.length === 0
    ),
    rankings_are_stable: profileResults.every(
      (profile) => profile.stable_ranking
    ),
    cold_start_is_user_independent: coldRanking === rankingOf(secondCold),
    personalized_differs_from_cold_start: profileResults.every(
      (profile) => profile.differs_from_cold_start
    ),
  };
  const qualityChecks = {
    every_profile_precision_at_5_at_least_0_8: profileResults.every(
      (profile) => profile.precision_at_5 >= 0.8
    ),
    every_profile_pair_top_5_overlap_at_most_0_25: overlaps.every(
      (entry) => entry.top_5_jaccard <= 0.25
    ),
  };
  const report = {
    base_url: baseUrl,
    catalog_id: catalogId,
    catalog: seeded,
    run_id: runId,
    cold_start: {
      user_id: coldUserId,
      strategy: cold.metadata.strategy,
      learned_from_interactions:
        cold.metadata.learned_from_interactions,
      second_user_id: secondColdUserId,
      second_strategy: secondCold.metadata.strategy,
    },
    correctness_checks: correctnessChecks,
    quality_checks: qualityChecks,
    profiles: profileResults,
    profile_separation: overlaps,
  };

  console.log(JSON.stringify(report, null, 2));

  if (Object.values(correctnessChecks).some((passed) => !passed)) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : error
  );
  process.exitCode = 1;
});
