# Libraries, Import Staging, and Configurable Sections

## Overview

Three connected features that move MediaForest from a flat search list toward an
organized, Netflix-style library browser:

1. **Libraries** — named buckets that group media (Movies, TV Shows, Personal, Horror, etc.)
2. **Import staging** — scan results are reviewed before being committed to the main feed
3. **Configurable home sections** — rows or grids on the main page, each filtered by any tag

---

## 1. Libraries

### What a library is

A library is a named label attached to a `media` node at import time.  It is
stored in the `library` field of `MediaPayload` and persists in the Hypercore feed.

Libraries are defined server-side in `server_key.json` under a `libraries` array.
Any media node can reference a library by its `id`.  The library definition just
carries display metadata — the `id` is what lives on the media node.

```json
// server_key.json excerpt
"libraries": [
  { "id": "movies",   "name": "Movies",    "color": "#6366f1", "defaultPath": "/media/Movies" },
  { "id": "tv",       "name": "TV Shows",  "color": "#10b981", "defaultPath": "/media/TV" },
  { "id": "personal", "name": "Personal",  "color": "#f59e0b" }
]
```

### Data model changes

`MediaPayload` (relay/types.ts):
```typescript
library?: string    // library id
tags?: string[]     // free-form tags for future filtering
```

### Server endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /libraries | Bearer | List all defined libraries |
| POST | /libraries | Bearer (owner) | Create a library |
| PATCH | /libraries/:id | Bearer (owner) | Rename / recolor |
| DELETE | /libraries/:id | Bearer (owner) | Remove definition (does not remove media) |

### Import flow with library selection

1. User opens Scan page
2. Before/after scanning: user selects a target library from a dropdown (defaults to last used)
3. The selected library id is attached to every media node created during import

---

## 2. Import Staging

### Problem

Currently, clicking Import immediately writes nodes to the Hypercore feed.  There
is no way to review the full set before committing, and no way to re-open a
previous scan session.

### Design

**Stage** = save the confirmed import plan (title, TMDB match, file list, library) 
to a local `staged_imports.json` file in the data directory.  Nothing is written to
the feed yet.

**Commit** = walk the staged items and write media + storage_pointer nodes to the feed.

This is a pure server-side concern — the client sends the same `ImportItem[]` payload
as today, but to `/import/stage` instead of `/media/import/batch`.

```
staged_imports.json
[
  {
    "id": "abc123",
    "stagedAt": 1780000000000,
    "library": "movies",
    "items": [ ...ImportItem[] ... ]
  }
]
```

### Server endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /import/staged | Bearer | List all staged import batches |
| POST | /import/stage | Bearer | Save a new staged batch (returns id) |
| POST | /import/commit/:id | Bearer | Execute a staged batch → feed |
| DELETE | /import/staged/:id | Bearer | Discard a staged batch |

### Client changes

- ScanPage shows **Stage** and **Import now** buttons (Import now = stage + immediate commit)
- A new **Staged Imports** indicator in the header badge when pending batches exist
- Clicking the badge opens a review panel listing staged batches with commit/discard

---

## 3. Scan review filter

A toggle button on the ScanPage:

```
[ Show all ]  vs  [ Uncertain only ]
```

When "Uncertain only" is active, only items where `matchState.needsReview && !matchState.confirmed`
are shown.  This lets the user rapidly review the small set of questionable matches
without scrolling past all the confident ones.

---

## 4. Configurable Home Sections

### What a section is

Each section on the home page is an independent view with:
- A title
- A display mode: `row` (horizontal scroll, 5–8 items) or `grid` (full-width multi-column)
- A filter: any combination of `library`, `genre`, `watchStatus`, `kind`, `available`
- An optional sort: `addedAt` (default), `year`, `title`

Sections are stored in `server_key.json` under `sections`:

```json
"sections": [
  {
    "id": "continue",
    "name": "Continue Watching",
    "view": "row",
    "filter": { "watchStatus": "watching" },
    "sort": "addedAt"
  },
  {
    "id": "movies-lib",
    "name": "Movies",
    "view": "grid",
    "filter": { "library": "movies" },
    "sort": "title"
  },
  {
    "id": "tv-lib",
    "name": "TV Shows",
    "view": "grid",
    "filter": { "library": "tv" },
    "sort": "title"
  },
  {
    "id": "new",
    "name": "Recently Added",
    "view": "row",
    "filter": {},
    "sort": "addedAt"
  }
]
```

Default sections are created automatically when the server first starts (or when no
sections are configured).  Default sections are derived from defined libraries.

### Server endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /config/sections | Bearer | List sections in display order |
| POST | /config/sections | Bearer (owner) | Create a section |
| PATCH | /config/sections/:id | Bearer (owner) | Update title/view/filter/sort |
| DELETE | /config/sections/:id | Bearer (owner) | Remove a section |
| POST | /config/sections/reorder | Bearer (owner) | Reorder (body: `{ ids: string[] }`) |

### Client: main page

The main page switches from a flat search+list to:

```
[header with search that filters across all sections]

─── Continue Watching ────────────────── [row: horizontal scroll]
  [card] [card] [card] [card] [card] →

─── Movies ───────────────────────────── [grid]
  [card] [card] [card]
  [card] [card] [card]

─── TV Shows ─────────────────────────── [grid]
  ...
```

When the search box has text, all sections collapse to a single flat results list
(same as current behavior).

Section view mode (row/grid) and section filters are configurable from Settings.

---

## Implementation Phases

### Phase A — libraries (this session)
- [x] `library` + `tags` fields on `MediaPayload`
- [x] `libraries` in `ServerKey`, CRUD endpoints
- [x] Library selector in ScanPage import flow
- [x] `library` passed through import batch → media node

### Phase B — scan filter (this session)
- [x] Uncertain-only toggle in ScanPage

### Phase C — sections (this session)
- [x] `sections` in `ServerKey`, CRUD endpoints
- [x] Auto-create default sections from libraries
- [x] Main page section renderer (row + grid modes)
- [x] Search collapses to flat list

### Phase D — import staging (next session)
- [ ] `staged_imports.json` persistence
- [ ] `/import/stage` and `/import/commit/:id` endpoints
- [ ] Stage/commit UI in ScanPage
- [ ] Staged badge in header

---

## Open Questions

1. **Per-user libraries?** Currently libraries are server-global. Should members be
   able to have private libraries visible only to them? Probably yes, long-term —
   would require `owner: pubKey` on the library def and section filter.

2. **Library for crosslinked content?** When you add a friend's content via crosslink,
   should you be able to tag it to your own library?  Makes sense — the crosslink
   payload could carry `library`.

3. **Section visibility per user?** Should members see different sections than the owner?
   Likely out of scope for now; all sections are server-global.
