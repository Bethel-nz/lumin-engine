# Build prompt: Lumin Console

Paste everything below this line into Gemini.

---

Build **Lumin Console**, a web interface for a recommendation engine called Lumin.

## 1. What Lumin is, and what the console is for

Lumin is a tenant-isolated recommendation service. A developer registers a *catalog* describing the shape of their items (movies, books, products, listings — anything), ingests items, records user interactions, and asks Lumin for recommendations. Lumin converts interaction history into a time-decayed taste vector and ranks unseen items against it.

The console has one job: **make the learning visible and verifiable.** A developer using it should be able to answer "is this actually personalizing, or is it just showing me popular items?" without reading server logs. Every screen serves that question.

This is a developer tool, not a consumer app. The user is technical, is evaluating whether to trust the engine, and wants evidence rather than reassurance.

## 2. Voice

Lumin's documentation reads like this:

> Upstash provides semantic retrieval, but a newly written vector can briefly be absent from a similarity query. Lumin does not pretend that retrying blindly is a consistency model.

> Interactions are weighted evidence, time decay changes their influence, and the resulting taste vector is derived state that can be rebuilt.

> D1 `LIKE` is deliberately the first implementation. A catalog-scoped FTS index is the next step when measured catalog size makes it worthwhile.

Declarative. Precise. Explains the *why*, names its own limitations, never sells. No exclamation marks, no "Oops!", no "Let's get started!", no emoji anywhere in the product surface.

Match this in every string you write. Interface copy is part of the build, not a pass at the end — write the real string the first time.

### Terminology — one word per concept, everywhere

Interface copy, error messages, table headers, and API-facing labels all use the same word for the same thing. If it is a "catalog" in the navigation, it is not a "collection" in a toast. Fix the vocabulary before you write a single screen:

| Use | Never | Meaning |
| --- | --- | --- |
| catalog | collection, dataset, index, workspace | The registered container for a set of items |
| item | record, entry, document, product, row | One thing Lumin can rank |
| field | column, property, key | A declared attribute on a catalog |
| embed config | embedding settings, vectorisation config | Which fields shape an item's meaning |
| interaction | event, signal, activity, engagement | One recorded user action on an item |
| action | interaction type, event type, verb | `like`, `view`, `dismiss`, and the rest |
| weight | strength, importance, value | The numeric influence of an action |
| taste vector | user profile, preference model, embedding | The derived representation of a user |
| strategy | mode, algorithm, method | `popular` or `personalized` |
| score | similarity, relevance, rank, match | The cosine similarity of an item |
| API key | token, secret, credential | The `X-Lumin-Key` value |
| ingest | upload, import, add, push | Writing an item into a catalog |
| record | log, track, send, capture | Writing an interaction |

`ingest` and `record` are deliberately different verbs for deliberately different operations — items are ingested, interactions are recorded. Keep them apart.

### Tone flexes with the stakes, voice does not

| Context | Tone |
| --- | --- |
| Empty states, first-run, successful ingest | Warm, plain, brief. Never jokey. |
| Routine actions, tables, filters, navigation | Neutral and minimal. Say the thing. |
| Errors, revoking a key, deleting a catalog | Calm and literal. Zero playfulness, no apology. |
| Anything revealing a key, or deleting data | Serious and explicit about what happens and what cannot be undone. |

Lumin's voice is constant across all four. Only the temperature changes.

### Copy rules

- **Sentence case everywhere** — buttons, headings, labels, table columns. Not Title Case.
- **Buttons start with a verb naming the action**: `Register catalog`, `Ingest item`, `Record interaction`, `Revoke key`. Never `OK`, `Submit`, `Yes`, `Let's go`.
- **Destructive confirmations repeat the consequence.** "Delete this catalog?" offers `Delete catalog` and `Cancel` — not `Yes`/`No`. The dialog must be answerable without reading the body.
- **Address the reader as "you."** Never "the user."
- **Errors are instructions placed next to the field that failed**, and they say how to fix it:
  - Not "Invalid field" → "Declare `author` in the catalog's fields before using it in an attribute."
  - Not "We're having trouble" → "Unable to reach the API. Check that the worker is running and try again."
- **Empty states orient and point forward.** Not "No items." →
  > **No items yet**
  > Items are what Lumin ranks. Ingest one to see recommendations change.
  > `Ingest item`
- **Search and filter empty states name the query and offer an exit**: "No results for 'quiet space mystery'. `Clear search`"
- **Links describe their destination.** "Read the interaction weights" — never "Learn more" or "Click here".
- **Never build sentences by concatenation.** Use full templated strings with proper pluralization: `{count, plural, one {# interaction} other {# interactions}}`, not `"Learned from " + n + " interactions"`. Word order changes between languages; a sentence assembled from fragments cannot be translated.
- **Placeholders show format, never replace a label.** Every field keeps a visible `<label for>`. `book-42` is a placeholder; `Item ID` is the label.
- **Match the verb to the input device.** This console is pointer-first, so "click" is fine — but where a control is reachable both ways, prefer "select". Never write "tap" on a desktop surface.
- **One vocabulary per flow.** The catalog creation flow enters with `Register catalog`, advances with `Continue` (never alternating with "Next"), and finishes with `Register catalog`. Alternating synonyms makes people wonder whether the buttons differ.
- **Toggles are labelled for what happens when they are on.** `Use dark theme`, not `Disable light theme`. Never label the negative — it makes the off state a double negative.
- **Link to a setting rather than describing the route to it.** A `Manage API keys` link, not "Go to Settings → Keys".
- **Hints appear before the mistake, not after.** The rule that an attribute must be declared on the catalog belongs beside the attributes input while it is being filled in — not in an error after submit.
- **Phrase hints positively.** "Use lowercase letters, numbers, and underscores", not "Don't use spaces or capitals".
- **Use possessives sparingly.** `Catalogs`, not `Your catalogs`. `API keys`, not `Your API keys`.
- **Never say "we" in an error.** "Unable to reach the API" — not "We couldn't reach the API", which reads as deflection and hides the recovery step.
- **Do not park persistent information in an empty state.** The interaction weights table and the explanation of embed config must live somewhere permanent; an empty state vanishes the moment data exists.
- **If one error keeps firing, the interaction is wrong.** An undeclared-attribute error that users hit repeatedly means the ingest form should be generated from the catalog's declared fields — which section 5.4 already requires. Redesign before rewording.

### Worked strings

Use these verbatim where they fit, and match their register everywhere else.

| Situation | Write |
| --- | --- |
| Catalog list, empty | **No catalogs yet** / A catalog describes the shape of your items and how they are embedded. / `Register catalog` |
| Items table, empty | **No items yet** / Items are what Lumin ranks. Ingest one to see recommendations change. / `Ingest item` |
| Search, no results | No results for "quiet space mystery". / `Clear search` |
| Recommendations, cold start | No interactions yet for this user. Showing catalog popularity. / `Record an interaction` |
| Undeclared attribute | Declare `author` in the catalog's fields before using it as an attribute. |
| Field name collides with a core column | `title` is a core field. Choose a different name. |
| Embed config references a missing field | `mood` is not a declared field on this catalog. Add it, or remove it from the embed config. |
| API unreachable | Unable to reach the API. Check that the worker is running, then retry. |
| Key revealed once | Copy this key now. It is not shown again. |
| Revoke confirmation | **Revoke this key?** / Requests using it will fail immediately. / `Revoke key` · `Cancel` |
| Delete catalog confirmation | **Delete this catalog?** / Its items, interactions, and vectors are removed. This cannot be undone. / `Delete catalog` · `Cancel` |
| Ingest succeeded | Ingested `book-42`. |
| Interaction recorded | Recorded `like` on `book-42`. Weight 2.0. |
| Strategy explanation, inline | Personalized ranking from {count, plural, one {# interaction} other {# interactions}}. |

Note what these avoid: no "Success!", no "Whoops", no "Are you sure?", no "Something went wrong". Every error names the thing that failed and the next move.

## 3. Theme

**Primary is violet `#7d52f4`.**

Rationale, so you don't drift from it: Lumin's design tokens come from a system where warm orange is already bound to both *primary* and *warning*. A warm accent for Lumin would collide with warning semantics. Violet is semantically free in that vocabulary, distinct at a glance, reads as computation rather than commerce, holds contrast in both light and dark mode, and works as the base of a data-visualisation scale. Lumin means light; a violet-to-white ramp is the luminous one.

Use violet for: primary actions, the active navigation state, focus rings, the `personalized` strategy badge, and score-intensity fills. Do not use it for decoration. If everything is violet, nothing is.

## 4. Design tokens

Define these exactly as CSS custom properties on `:root`. Do not invent values outside this scale. Do not use raw hex in components — reference the tokens.

```css
:root {
  /* Backgrounds */
  --bg-default: #ffffff;
  --bg-surface: #f7f7f7;
  --bg-light:   #fcfcfc;
  --bg-layer:   #f5f5f5;
  --bg-subtle:  #ebebeb;
  --bg-muted:   #d1d1d1;

  /* Text */
  --text-strong:   #171717;
  --text-sub:      #5c5c5c;
  --text-soft:     #a3a3a3;
  --text-disabled: #d1d1d1;
  --text-inverse:  #ffffff;
  --text-accent:   #7d52f4;

  /* Strokes */
  --stroke-soft:   rgba(0, 0, 0, 0.05);
  --stroke-medium: rgba(0, 0, 0, 0.10);
  --stroke-strong: rgba(0, 0, 0, 0.20);

  /* Primary — violet */
  --primary-dark:  #351a75;
  --primary-base:  #7d52f4;
  --primary-faint: #cac0ff;
  --primary-mute:  #efebff;

  /* Info */
  --info-dark: #122368;  --info-base: #335cff;
  --info-faint: #c0d5ff; --info-mute: #ebf1ff;

  /* Success */
  --success-dark: #0b4627;  --success-base: #1fc16b;
  --success-faint: #c2f5da; --success-mute: #e0faec;

  /* Warning */
  --warning-dark: #71330a;  --warning-base: #fa7319;
  --warning-faint: #ffd9c0; --warning-mute: #fff3eb;

  /* Error */
  --error-dark: #681219;  --error-base: #fb3748;
  --error-faint: #ffc0c5; --error-mute: #ffebec;

  /* Focus rings: 2px background gap, then a 4px colour ring */
  --focus-active: 0 0 0 2px var(--bg-default), 0 0 0 4px rgba(125, 82, 244, 0.24);
  --focus-error:  0 0 0 2px var(--bg-default), 0 0 0 4px var(--error-faint);

  /* Shadows */
  --shadow-xs: 0px 5px 13px -5px rgba(0,0,0,0.05), 0px 2px 4px -1px rgba(0,0,0,0.02);
  --shadow-sm: 0px 10px 20px 3px rgba(0,0,0,0.04);
  --shadow-md: 0px 16px 24px -4px rgba(0,0,0,0.08), 0px 4px 6px -2px rgba(0,0,0,0.03);
  --shadow-lg: 0px 14px 22px -9px rgba(0,0,0,0.14), 0px 0px 3px -1px rgba(0,0,0,0.04);

  /* Radius */
  --radius-xs: 4px;  --radius-sm: 6px;  --radius-md: 8px;
  --radius-lg: 12px; --radius-xl: 16px; --radius-full: 9999px;

  /* Typography */
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --text-xs: 12px;  --text-sm: 14px;  --text-md: 16px;
  --text-lg: 20px;  --text-xl: 24px;  --text-2xl: 32px;
}
```

**Dark mode is required**, and must respond to *both* `@media (prefers-color-scheme: dark)` and a manual `[data-theme="dark"]` attribute on `<html>`, so a toggle can override the OS. Invert the background and text ramps; keep `--primary-base` recognisable (lighten toward `#9670ff` if contrast requires it) and re-check every pair.

**Monospace is meaningful, not decorative.** Use `--font-mono` for exactly these: IDs (`item_id`, `catalog_id`, `user_id`), API keys, scores, JSON, and endpoint paths. Everything else is `--font-sans`.

## 5. Screens

### 5.1 Sign in / sign up
Better Auth email + password. One form, visible labels, `autocomplete="email"` and `autocomplete="current-password"`. Never block paste.

### 5.2 API keys
List keys with prefix, name, created date, last used. `Create key` reveals the full key **once**, in a monospace block with a copy button and this warning: "Copy this key now. It is not shown again." Revoking asks "Revoke this key?" with `Revoke key` / `Cancel`.

### 5.3 Catalogs
A list, plus a create form. The create form is the most important form in the product, so build it carefully:

- **Name** — text input, lowercase identifier.
- **Fields** — a repeatable row editor: field name + a type select (`string`, `number`, `boolean`, `string[]`). `Add field` appends a row; each row has a `Remove` control with an accessible name that includes the field name ("Remove field author").
- **Embed config** — two inputs that decide what Lumin actually learns from:
  - `text_fields`: a multi-select over the core fields (`title`, `description`, `tags`, `category`) **plus** whatever custom fields were declared above. It must update live as fields are added.
  - `image_field`: a select, optional, defaulting to `image_url`.

Explain the embed config inline, in Lumin's voice, because it is the concept users get wrong:

> Embed config decides what shapes an item's meaning. Fields listed here are read by the embedding model; fields left out are stored and returned, but do not influence ranking.

Validate before submit and show errors next to the offending row. A field name that collides with a core column (`item_id`, `title`, `description`, `tags`, `category`, `image_url`, `price`, `tenant_id`, `catalog_id`, `attributes`) is rejected — say which name and why.

### 5.4 Catalog detail → Items
A table: image thumbnail, title, category, tags, `item_id` in mono. Row click opens a detail panel showing every field including `attributes` as formatted JSON. An `Ingest item` action opens a form generated **from that catalog's declared fields** — core fields plus one input per custom field, typed correctly (number input for `number`, checkbox for `boolean`, tag entry for `string[]`).

### 5.5 Search
A single query input. Results show, per item, three numbers: the **combined score**, and its **semantic** and **lexical** components, plus which source produced it. This is a distinguishing feature of the engine — surface it rather than hiding it behind a single number. A small stacked bar per row showing the 75/25 split reads faster than three decimals, but keep the numbers available as text.

### 5.6 Recommendations explorer — the centrepiece
Given a `user_id` and a catalog, show the ranked list. This screen must answer "is it learning?" at a glance:

- A **strategy badge**: `personalized` in violet, `popular` in neutral grey. These are genuinely different modes and must never look alike.
- `Learned from {n} interactions` beside it.
- Each result: rank, thumbnail, title, score, and the item's tags.
- **Cold start is a real state, not an error.** When strategy is `popular`, show a calm inline note: "No interactions yet for this user. Showing catalog popularity." with a `Record an interaction` action.

Below the list, an **interaction recorder**: pick an item, pick an action, submit. Then re-fetch and show what changed. The moment a developer sees the ranking move after recording a `like`, they believe the engine. Design for that moment.

Actions and their weights — display them, in this order, so the weighting is never a mystery:

| Action | Weight |
| --- | ---: |
| `complete` | 3.0 |
| `purchase` | 3.0 |
| `like` | 2.0 |
| `save` | 1.5 |
| `click` | 1.0 |
| `view` | 0.25 |
| `dismiss` | −1.0 |
| `dislike` | −2.0 |

**Do not invent an explanation feature.** Do not render "Because you liked X" unless the API returns per-item contributions. The taste vector is a normalised blend; individual contributions are not recoverable from it, and a guessed explanation is a confident lie. If the API adds contributions later, show them then.

**Do not present a cosine score as a probability.** `0.89` is vector similarity, not "89% likely to enjoy". Label the column `Score`, never `Match %` or `Confidence`.

## 6. Layout rules

- **Group with space, not lines.** The gap between groups is at least 2× the gap within a group (8px inside → 16px+ between). Reach for a separator only where space alone cannot carry the structure.
- **Align to shared edges.** One spacing step per level of subordination. Every stray edge reads as noise.
- **Use logical properties** — `padding-inline-start`, `margin-inline-end` — not `left`/`right`, except for genuinely physical geometry.
- **Order by importance**: most important content at the top and leading edge.
- **Breakpoints come from the content**, not device presets. Hold the expanded layout until it genuinely stops fitting, then collapse. Prefer container queries for component-level adaptation.
- **No fixed widths or heights on text containers.** Use `min-height` and let rows wrap; strings grow when translated.
- **Reflow at 320px with no horizontal scrolling**, and stay usable at 200% zoom. Wide tables scroll inside their own container — the page body never scrolls sideways.
- Keep at least 12px between adjacent bordered controls, and 24px of clearance around icon-only controls.

## 7. Accessibility — non-negotiable

- **Native elements first.** `<button>` for actions, `<a href>` for navigation. Never `<div onClick>`. No ARIA beats bad ARIA.
- **Visible focus rings on `:focus-visible`**, using `--focus-active`. Never `outline: none` without a verified replacement. Verify the ring against every surface it lands on.
- **Every flow completes without a mouse.** Escape closes overlays; arrow keys move within tabs/menus/listboxes; Tab moves between widgets; Enter and Space activate. Only `tabindex="0"` and `tabindex="-1"` — never positive values.
- **Dialogs** set `inert` on background content, move focus inside on open, restore focus to the trigger on close, and use `overscroll-behavior: contain`.
- **Every input has a visible `<label for>`.** The label and its control share one hit target.
- **Errors announce**: `aria-invalid="true"` on the field, `aria-describedby` pointing at the inline error, focus the first invalid field on submit. Keep submit enabled until the request starts; then disable with a spinner and keep the original label.
- **Icon-only buttons get a descriptive `aria-label`**; decorative icons get `aria-hidden="true"`. Never `aria-hidden` on anything focusable.
- **Never rely on colour alone.** The `personalized` / `popular` badges carry text, not just hue. Score intensity carries a number, not just a fill.
- **Minimum 24×24px targets**, 44×44px in touch contexts.
- **Live regions**: `role="status"` (polite) for toasts and result counts; `role="alert"` only for urgent errors. Render a stable empty region and update its text rather than inserting one.
- **Honour `prefers-reduced-motion`**: wrap motion in `@media (prefers-reduced-motion: no-preference)`; under reduced motion replace slides and scales with opacity crossfades.
- **One `<h1>` per page**, properly nested headings, one `<main>` landmark, and a "Skip to content" link as the first focusable element.
- Never `user-scalable=no` or `maximum-scale=1`.

## 8. API contract

Base URL is configurable. Authenticate with the header `X-Lumin-Key: <key>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/catalogs` | Register a catalog |
| `GET` | `/api/catalogs` | List catalogs |
| `GET` | `/api/catalogs/:catalogId` | Fetch one catalog |
| `POST` | `/api/catalogs/:catalogId/items` | Ingest or update an item |
| `GET` | `/api/catalogs/:catalogId/items?limit=50` | List items |
| `GET` | `/api/catalogs/:catalogId/items/:itemId` | Fetch one item |
| `POST` | `/api/catalogs/:catalogId/interactions` | Record an interaction |
| `GET` | `/api/catalogs/:catalogId/search?query=&limit=20` | Hybrid search |
| `GET` | `/api/catalogs/:catalogId/users/:userId/recommendations?limit=20` | Recommendations |

Auth uses Better Auth: `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, and `POST /api/auth/api-key/create`, `GET /api/auth/api-key/list`, `POST /api/auth/api-key/delete`.

Register a catalog:
```json
{
  "name": "books",
  "fields": [
    { "name": "author", "type": "string" },
    { "name": "year", "type": "number" },
    { "name": "themes", "type": "string[]" }
  ],
  "embed_config": {
    "text_fields": ["title", "description", "tags", "author", "themes"],
    "image_field": "image_url"
  }
}
```

Ingest an item — every attribute must be declared by the catalog, and `item_id` is the idempotency key:
```json
{
  "item_id": "book-42",
  "title": "A Map of Small Decisions",
  "description": "A reflective novel about cities, memory, and friendship.",
  "tags": ["literary", "city", "friendship"],
  "category": "fiction",
  "image_url": "https://example.com/cover.jpg",
  "price": 14.99,
  "attributes": { "author": "M. Nwosu", "year": 2025, "themes": ["memory", "belonging"] }
}
```

Record an interaction — omit `id` and Lumin generates one:
```json
{
  "user_id": "user-7",
  "item_id": "book-42",
  "action": "like",
  "session_id": "session-9",
  "source": "web"
}
```

Recommendations response:
```json
{
  "recommendations": [
    {
      "item_id": "tmdb-19995",
      "score": 0.9239974,
      "title": "Avatar",
      "description": "…",
      "tags": ["Action", "Science Fiction"],
      "category": "Action",
      "image_url": "https://…",
      "price": 0,
      "attributes": { "year": 2009, "director": "James Cameron" }
    }
  ],
  "metadata": {
    "tenant_id": "…",
    "catalog_id": "…",
    "user_id": "usr_e00eqy5x",
    "strategy": "personalized",
    "learned_from_interactions": 8,
    "cache_hit": false
  }
}
```

A catalog belonging to another tenant returns `404`, never `403` — treat 404 as "not found" and never imply the resource exists.

## 9. Required states

Build every one of these for each data surface. Do not ship only the happy path:

- **Loading** — skeletons matching the final layout, not a centred spinner that shifts content.
- **Empty** — orienting copy plus one next action.
- **Error** — what failed and what to do, with a retry.
- **Cold start** — a real, calm state on the recommendations screen, not an error.
- **Partial** — search returned lexical results but semantic is still warming.

## 10. Do not

- Do not use emoji in the product surface.
- Do not add a chart library for a two-value split; a stacked bar is CSS.
- Do not invent metrics the API doesn't return — no "confidence", no "match %", no fabricated explanations.
- Do not use gradients, glassmorphism, or decorative animation. Motion is for state changes and orientation only.
- Do not use Title Case.
- Do not put the primary action where scrolling clips it.
- Do not build a settings page, billing, or team management. They are not in scope.

## 11. Stack

Next.js App Router, TypeScript, Tailwind CSS v4 with the tokens above defined as CSS custom properties and exposed through `@theme`. No component library — build the components. Keep files focused: one component per file, and split anything that grows past roughly 200 lines.

## Definition of done

- Every screen in section 5 exists with all five states from section 9.
- Keyboard-only traversal completes every flow, with a visible focus ring at every stop.
- Light and dark mode both verified, via OS preference and the manual toggle.
- Reflows at 320px and remains usable at 200% zoom.
- No raw hex in components; every colour references a token.
- No string built by concatenation around a variable; counts use pluralized templates.
- Every concept uses its one approved term from section 2. Grep the source for the banned words — `collection`, `dataset`, `record` as a noun, `event`, `signal`, `user profile`, `match`, `confidence`, `token` for API key — and fix each hit.
- Every button label starts with a verb. No `OK`, `Submit`, `Yes`, or `No` anywhere.
- Every destructive dialog names its consequence in the confirming button.
- Sentence case throughout; grep for Title Case in buttons and headings.
- Every field has a visible label; no placeholder is doing a label's job.
- No exclamation marks, no "oops", no emoji in any user-facing string.
