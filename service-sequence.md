```mermaid
sequenceDiagram
    actor User

    alt Get Recommendations
        User->>+Lumin Service: GET /get-recommendations/:userId
        Lumin Service->>+KV Cache: Get cached recommendations
        alt Cache Hit
            KV Cache-->>-Lumin Service: Return cached recommendations
            Lumin Service-->>-User: 200 OK (cached recommendations)
        else Cache Miss
            KV Cache-->>-Lumin Service: No cached data
            Lumin Service->>+Services: computeHybridUserVector(userId)
            Services->>+D1 Database: Get user interactions, demographics
            D1 Database-->>-Services: Return user data
            Services->>+KV Cache: Get user_tags
            KV Cache-->>-Services: Return user_tags
            Services->>+Upstash Vector: buildInteractionVector, getCollaborativeVector
            Upstash Vector-->>-Services: Return vectors
            Services->>+OpenAI: generateEmbedding (for tags, demographics)
            OpenAI-->>-Services: Return embeddings
            Services-->>-Lumin Service: Return hybrid user vector
            Lumin Service->>+Upstash Vector: query(userVector)
            Upstash Vector-->>-Lumin Service: Return candidate events
            Lumin Service->>+Services: Apply exploration & diversification
            Services-->>-Lumin Service: Return final recommendations
            Lumin Service->>+KV Cache: Store recommendations
            KV Cache-->>-Lumin Service: Confirm storage
            Lumin Service-->>-User: 200 OK (recommendations)
        end
    end

    alt Ingest Event
        User->>+Lumin Service: POST /ingest-event
        Lumin Service->>+Services: processEventIngestion(eventData)
        par
            Services->>+OpenAI: generateEmbedding(text)
            OpenAI-->>-Services: Return vector
        and
            Services->>+Tinybird: Ingest event analytics
            Tinybird-->>-Services: Confirm ingestion
        end
        par
            Services->>+Upstash Vector: upsert(vector)
            Upstash Vector-->>-Services: Confirm upsert
        and
            Services->>+D1 Database: Insert event reference
            D1 Database-->>-Services: Confirm insert
        end
        Services-->>-Lumin Service: Ingestion successful
        Lumin Service-->>-User: 201 Created
    end

    alt Log Interaction
        User->>+Lumin Service: POST /log-interactions
        Lumin Service->>+Tinybird: Ingest interaction analytics
        Tinybird-->>-Lumin Service: Confirm ingestion
        Lumin Service->>+D1 Database: Check if new user & insert signup
        D1 Database-->>-Lumin Service: User status
        Lumin Service->>+KV Cache: Delete cached recommendations
        KV Cache-->>-Lumin Service: Confirm deletion
        Lumin Service-->>-User: 201 Created
    end
```
