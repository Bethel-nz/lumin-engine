export {};

const baseUrl = process.env.LUMIN_BASE_URL ?? 'http://localhost:8787';

const request = async (
  path: string,
  init: RequestInit = {},
  apiKey?: string
) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...init.headers,
    },
  });
  const body = (await response
    .json()
    .catch(() => ({}))) as Record<string, any>;
  return { response, body };
};

const configuredApiKey = process.env.LUMIN_API_KEY;
const seed = configuredApiKey
  ? undefined
  : await request('/api/admin/seed', { method: 'POST' });
const apiKey =
  configuredApiKey ||
  (typeof seed?.body.apiKey === 'string' ? seed.body.apiKey : undefined);

if (!apiKey) throw new Error('The local seed endpoint did not return an API key.');

const catalogDefinition = {
  name: 'movie-demo',
  fields: [
    { name: 'year', type: 'number' },
    { name: 'director', type: 'string' },
    { name: 'runtime_minutes', type: 'number' },
    { name: 'mood', type: 'string[]' },
    { name: 'language', type: 'string' },
  ],
  embed_config: {
    text_fields: [
      'title',
      'description',
      'tags',
      'category',
      'director',
      'mood',
    ],
    image_field: 'image_url',
  },
};

let catalogId: string;
const created = await request(
  '/api/catalogs',
  {
    method: 'POST',
    body: JSON.stringify(catalogDefinition),
  },
  apiKey
);

if (created.response.status === 201) {
  catalogId = String(created.body.catalog_id);
} else if (created.response.status === 409) {
  const listed = await request('/api/catalogs', {}, apiKey);
  const existing = Array.isArray(listed.body.catalogs)
    ? listed.body.catalogs.find(
        (catalog: { name?: string }) => catalog.name === catalogDefinition.name
      )
    : undefined;
  if (!existing?.catalog_id) {
    throw new Error('Movie catalog exists but could not be resolved.');
  }
  catalogId = String(existing.catalog_id);
} else {
  throw new Error(
    `Could not create movie catalog: ${created.response.status} ${JSON.stringify(created.body)}`
  );
}

const movies = [
  {
    item_id: 'signal-beyond',
    title: 'Signal Beyond',
    description:
      'A patient radio astronomer discovers a repeating signal that seems to predict human decisions.',
    tags: ['space', 'mystery', 'slow-burn', 'science-fiction'],
    category: 'science-fiction',
    attributes: {
      year: 2024,
      director: 'Mara Okafor',
      runtime_minutes: 118,
      mood: ['cerebral', 'atmospheric'],
      language: 'English',
    },
  },
  {
    item_id: 'glass-orbit',
    title: 'Glass Orbit',
    description:
      'Two engineers on a failing orbital station must choose between returning home and protecting a dangerous discovery.',
    tags: ['space', 'survival', 'technology', 'thriller'],
    category: 'science-fiction',
    attributes: {
      year: 2023,
      director: 'Jon Bell',
      runtime_minutes: 106,
      mood: ['tense', 'immersive'],
      language: 'English',
    },
  },
  {
    item_id: 'borrowed-summers',
    title: 'Borrowed Summers',
    description:
      'Childhood friends reunite in a coastal town and confront the future they once imagined together.',
    tags: ['romance', 'friendship', 'coastal', 'drama'],
    category: 'romance',
    attributes: {
      year: 2022,
      director: 'Amaka Nwosu',
      runtime_minutes: 101,
      mood: ['warm', 'bittersweet'],
      language: 'English',
    },
  },
  {
    item_id: 'after-the-rain-market',
    title: 'After the Rain Market',
    description:
      'A food photographer returns to Lagos and finds a new direction while documenting a historic market.',
    tags: ['food', 'lagos', 'family', 'romance'],
    category: 'drama',
    attributes: {
      year: 2024,
      director: 'Tomi Adeyemi',
      runtime_minutes: 96,
      mood: ['hopeful', 'intimate'],
      language: 'English',
    },
  },
  {
    item_id: 'the-last-debugger',
    title: 'The Last Debugger',
    description:
      'A burned-out engineer is pulled into a conspiracy hidden inside an abandoned city operating system.',
    tags: ['technology', 'conspiracy', 'cyberpunk', 'thriller'],
    category: 'thriller',
    attributes: {
      year: 2025,
      director: 'Eli Mercer',
      runtime_minutes: 112,
      mood: ['fast', 'dark'],
      language: 'English',
    },
  },
  {
    item_id: 'small-hours',
    title: 'Small Hours',
    description:
      'Over one sleepless night, a taxi driver and five passengers quietly reshape one another’s lives.',
    tags: ['city', 'anthology', 'human', 'night'],
    category: 'drama',
    attributes: {
      year: 2021,
      director: 'Lena Park',
      runtime_minutes: 94,
      mood: ['reflective', 'gentle'],
      language: 'English',
    },
  },
  {
    item_id: 'wild-index',
    title: 'Wild Index',
    description:
      'A documentary team follows conservationists building an open map of a rapidly changing rainforest.',
    tags: ['nature', 'documentary', 'climate', 'mapping'],
    category: 'documentary',
    attributes: {
      year: 2023,
      director: 'Rui Santos',
      runtime_minutes: 87,
      mood: ['curious', 'urgent'],
      language: 'English',
    },
  },
  {
    item_id: 'paper-kingdom',
    title: 'Paper Kingdom',
    description:
      'A meticulous archivist learns that a forgotten children’s story may document a real political disappearance.',
    tags: ['books', 'history', 'mystery', 'investigation'],
    category: 'mystery',
    attributes: {
      year: 2022,
      director: 'Nadia Cole',
      runtime_minutes: 109,
      mood: ['layered', 'suspenseful'],
      language: 'English',
    },
  },
  {
    item_id: 'second-service',
    title: 'Second Service',
    description:
      'An aging tennis coach takes one final chance on an impulsive player with uncommon instincts.',
    tags: ['sports', 'mentorship', 'competition', 'comedy'],
    category: 'comedy',
    attributes: {
      year: 2024,
      director: 'Felix Grant',
      runtime_minutes: 99,
      mood: ['energetic', 'uplifting'],
      language: 'English',
    },
  },
  {
    item_id: 'echoes-in-blue',
    title: 'Echoes in Blue',
    description:
      'A jazz quartet attempts to finish an album after its bandleader vanishes before the final session.',
    tags: ['music', 'jazz', 'friendship', 'mystery'],
    category: 'drama',
    attributes: {
      year: 2020,
      director: 'Sade Williams',
      runtime_minutes: 103,
      mood: ['melancholic', 'soulful'],
      language: 'English',
    },
  },
  {
    item_id: 'minute-zero',
    title: 'Minute Zero',
    description:
      'A paramedic relives the same twelve minutes and must understand the stranger whose life resets with hers.',
    tags: ['time-loop', 'action', 'mystery', 'science-fiction'],
    category: 'science-fiction',
    attributes: {
      year: 2025,
      director: 'Inez Calder',
      runtime_minutes: 104,
      mood: ['urgent', 'emotional'],
      language: 'English',
    },
  },
  {
    item_id: 'the-quiet-table',
    title: 'The Quiet Table',
    description:
      'Four estranged siblings cook their mother’s unfinished recipes while deciding what to do with the family home.',
    tags: ['family', 'food', 'grief', 'home'],
    category: 'drama',
    attributes: {
      year: 2023,
      director: 'Kemi Ajayi',
      runtime_minutes: 97,
      mood: ['tender', 'grounded'],
      language: 'English',
    },
  },
];

let ingested = 0;
for (const movie of movies) {
  const result = await request(
    `/api/catalogs/${catalogId}/items`,
    {
      method: 'POST',
      body: JSON.stringify(movie),
    },
    apiKey
  );
  if (result.response.status !== 201) {
    throw new Error(
      `Failed to ingest ${movie.item_id}: ${result.response.status} ${JSON.stringify(result.body)}`
    );
  }
  ingested += 1;
}

console.log(
  JSON.stringify(
    {
      base_url: baseUrl,
      catalog_id: catalogId,
      seeded_items: ingested,
      demo_user_id: 'demo-user',
      api_key: process.env.LUMIN_API_KEY ? '(from LUMIN_API_KEY)' : apiKey,
      recommendation_endpoint: `/api/catalogs/${catalogId}/users/demo-user/recommendations`,
    },
    null,
    2
  )
);
