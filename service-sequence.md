# Lumin Engine request sequences

This file is the sequence-level companion to
[`service-architecture.md`](./service-architecture.md).

## Protected request pipeline

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Hono Worker
    participant A as Better Auth
    participant D as D1

    C->>W: Request with API key
    W->>A: verifyApiKey(key)
    A->>D: Read API-key record
    D-->>A: referenceId and key state
    A-->>W: Verified tenant identity
    W->>D: Get catalog by id and tenant_id
    alt Catalog belongs to tenant
        D-->>W: Catalog and embed configuration
        W->>W: Run route handler
    else Missing or foreign catalog
        D-->>W: No row
        W-->>C: 404 Catalog not found
    end
```

## Register catalog

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Worker
    participant D as D1

    C->>W: POST /api/catalogs
    W->>W: Authenticate and validate declaration
    W->>D: Ensure tenant
    W->>D: Insert catalog fields and embed_config
    D-->>W: catalog_id
    W-->>C: 201 Created
```

## Ingest or update item

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Worker
    participant G as Gemini
    participant T as Tinybird
    participant V as Upstash Vector
    participant D as D1

    C->>W: POST /api/catalogs/:catalogId/items
    W->>W: Authenticate, scope, and validate attributes
    W->>W: Build embedding input from catalog config
    par Build representation
        W->>G: RETRIEVAL_DOCUMENT embedding
        G-->>W: 1536-dimensional vector
    and Append analytics version
        W->>T: Ingest items__v1 row
        T-->>W: Accepted
    end
    alt Valid non-zero vector
        par Upsert retrieval index
            W->>V: Upsert item vector and metadata
            V-->>W: Accepted
        and Upsert operational read model
            W->>D: Upsert catalog_items row
            D-->>W: Committed
        end
        W-->>C: 201 Created
    else Embedding unavailable
        W-->>C: Ingestion error
    end
```

## Record interaction

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Worker
    participant D as D1
    participant T as Tinybird
    participant K as KV

    C->>W: POST /api/catalogs/:catalogId/interactions
    W->>D: Get scoped item
    alt Item exists
        W->>W: Map action to weight
        par Online learning record
            W->>D: Insert interaction on conflict do nothing
            D-->>W: Stored or duplicate
        and Analytics record
            W->>T: Append interaction with stable ID
            T-->>W: Accepted
        end
        W->>K: Delete user recommendation cache
        W-->>C: 201 Created
    else Item missing
        W-->>C: 404 Item not found
    end
```

## Get recommendations

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Worker
    participant K as KV
    participant D as D1
    participant V as Upstash Vector

    C->>W: GET /users/:userId/recommendations
    W->>K: Get scoped user cache
    alt Cache hit
        K-->>W: Cached ranked response
        W-->>C: 200 Recommendations
    else Cache miss
        K-->>W: No value
        W->>D: Read latest 200 user interactions
        alt User has usable signals
            W->>V: Fetch interacted item vectors
            V-->>W: Item vectors
            W->>W: Weight, decay, aggregate, normalize
            W->>V: Query nearest candidates
            V-->>W: Ranked candidates
            W->>W: Remove previously seen items
        else Cold user
            W->>D: Aggregate catalog popularity
            D-->>W: Weighted popular items
        end
        W->>K: Cache ranked response for 30 minutes
        W-->>C: 200 Recommendations
    end
```

## Hybrid search

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Worker
    participant D as D1
    participant G as Gemini
    participant V as Upstash Vector

    C->>W: GET /search?query=...
    par Immediate lexical path
        W->>D: Scoped LIKE search
        D-->>W: Exact and lexical matches
    and Semantic representation
        W->>G: RETRIEVAL_QUERY embedding
        G-->>W: Query vector
    end
    W->>V: Namespace similarity query
    V-->>W: Semantic matches
    W->>W: Merge by item_id and apply 75/25 fusion
    W-->>C: 200 Ranked search results
```

## Failure boundary

The item and interaction write sequences contain parallel writes to independent
systems. They are not distributed transactions. A partial success can occur
before the Worker returns an error.

The intended production evolution is:

```mermaid
sequenceDiagram
    participant C as Customer
    participant W as Worker
    participant D as D1
    participant Q as Outbox worker
    participant X as Derived stores

    C->>W: Write command
    W->>D: Transaction: operational row plus outbox job
    D-->>W: Committed
    W-->>C: Accepted with indexing state
    Q->>D: Claim outbox job
    Q->>X: Deliver embedding, vector, and analytics writes
    X-->>Q: Accepted
    Q->>D: Mark job complete
```
