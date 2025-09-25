
```mermaid
graph TD
    subgraph User
        A[User Client]
    end

    subgraph Lumin Service (Hono)
        B["/ (GET)"]
        C["/get-recommendations/:userId (GET)"]
        D["/ingest-event (POST)"]
        E["/log-interactions (POST)"]
        F["/search (GET)"]
    end

    subgraph Services
        G[recommendations]
        H[eventService]
        I[exploration]
        J[analytics]
        K[vector]
        L[database]
        M[scheduled]
        N[observability]
        O[compensation]
        P[similarity-batch]
    end

    subgraph External Services
        Q[OpenAI]
        R[Upstash Vector]
        S[Tinybird]
    end

    subgraph Data Stores
        T[D1 Database (Drizzle)]
        U[KV Cache]
        V[TAG_VECTORS_KV]
    end

    subgraph Scheduled Tasks
        W["Cron: */30 * * * * (Update Tag Vectors)"]
        X["Cron: 0 * * * * (Pre-compute Recommendations)"]
    end

    A --> B
    A --> C
    A --> D
    A --> E
    A --> F

    C --> G
    D --> H
    E --> L
    E --> S
    F --> K

    G --> K
    G --> L
    G --> I
    G --> J
    G --> U

    H --> K
    H --> S
    H --> T
    H --> R
    H --> O

    I --> J
    I --> K

    J --> S

    K --> Q
    K --> R

    L --> T

    M --> K
    M --> L
    M --> U

    O --> T

    P --> T

    W --> M
    X --> M
```
