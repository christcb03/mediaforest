# Plex Sync — Design & Requirements

## Goal

Allow users to import their existing Plex library and watchlist into MediaForest, and keep watch status in sync between the two systems.

## User Stories

1. **Library import**: "I have 500 movies in Plex. I want them all in MediaForest with their TMDB metadata and watch history."
2. **Watch status sync**: "I watched something in Plex — MediaForest should show it as watched."
3. **Ongoing sync**: "When I finish something in Plex, sync it to MediaForest automatically (or on demand)."

## Out of Scope (v1)

- Pushing watch status *back* to Plex from MediaForest
- Real-time sync via Plex webhooks (requires paid Plex Pass)
- Episode-level watch status (series-level only for now)
- Transcoding or proxying Plex streams through MediaForest

---

## Architecture

### Plex Provider Config

Stored in `server_key.json` alongside the TMDB provider:

```json
{
  "provider_id": "plex",
  "name": "Plex Media Server",
  "enabled": true,
  "config": {
    "server_url": "http://192.168.1.100:32400",
    "token": "xxxxxxxxxxxxxxxxxxxx"
  }
}
```

Getting the Plex token: `Settings → account on plex.tv → Privacy → token`, or from any Plex API response header `X-Plex-Token`.

### Plex API Usage

MediaForest calls the **local Plex server** directly (same network). All requests include `X-Plex-Token` as a query param or header, and `Accept: application/json`.

Key endpoints:

- `GET /library/sections` — list all libraries
- `GET /library/sections/{key}/all` — all items in a library (movies or shows)
- Per-item: `Guid[]` array contains `tmdb://`, `imdb://`, `tvdb://` IDs for direct matching

### Import Flow

```
PlexSyncPage
  → GET /plex/libraries         (lists Plex sections)
  → POST /plex/import           (imports one section)
      ↓
  Server fetches all Plex items for the section
  For each item:
    1. Extract TMDB/IMDB ID from Plex Guid list
    2. If TMDB ID found: fetch TMDB details (genres, poster, runtime)
    3. Create/find MediaForest media node (dedup by tmdb_id)
    4. Create storage_pointer: endpoint_url = Plex direct-play URL
    5. If syncWatchStatus=true: create/update watchlist_entry
```

### Watch Status Sync

```
POST /plex/sync-watch
```

- Reads all existing storage_pointer nodes with `endpoint_url` containing `/plex/`
- For each, queries Plex for current `viewCount` / `lastViewedAt`
- Maps to MediaForest watchlist status:
  - `viewCount > 0` → `watched`
  - `viewCount = 0, lastViewedAt` exists → `watching`
  - neither → `unwatched`
- Creates or updates watchlist_entry nodes

### Stream URL Format

Plex direct-play URLs:
```
{server_url}/library/parts/{partKey}/file?X-Plex-Token={token}
```

Stored as the `endpoint_url` on the storage_pointer node. When played, the client opens this URL directly in the browser/player.

---

## Data Model

### LibraryRecord additions (no changes needed)

Libraries in MediaForest are named buckets. Plex sections map to MediaForest libraries by name (user chooses the mapping on import).

### StoragePointerPayload additions

No schema changes needed. The `endpoint_url` field holds the Plex direct-play URL. The `feedOwner` on the serialized result identifies which feed contributed the pointer.

---

## Server Endpoints

```
GET  /plex/libraries
     → { sections: PlexSection[] }

POST /plex/import
     body: { sectionKey, library?, syncWatchStatus?, tags? }
     → { imported, skipped, failed, results[], failures[] }

POST /plex/sync-watch
     → { updated, skipped }
```

---

## Client: PlexSyncPage

New page, accessible from a "Plex" button in the header (owner only).

Sections:
1. **Connection** — shows Plex server URL + status (connected/error)
2. **Libraries** — list of Plex sections with item counts; "Import" button per section with options (target library, sync watch status checkbox)
3. **Sync Watch Status** — "Sync Now" button to pull latest watch state from Plex

---

## Implementation Phases

### Phase A — Done when this doc is written
- Design doc

### Phase B — Current session
- `src/plex/client.ts` — Plex API client
- Server: Plex provider config + `/plex/libraries` + `/plex/import` + `/plex/sync-watch`
- Settings: Plex server URL + token fields
- Client: `PlexSyncPage.tsx` with library list + import button

### Phase C — Future
- Per-section import progress (streaming/polling like ScanPage)
- Push watch status back to Plex on MediaForest update
- Webhook receiver for real-time Plex → MediaForest sync
- Episode-level granularity
