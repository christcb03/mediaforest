# MediaForest Architecture

**MediaForest** is the personal media library application in this repository. It runs on **[PhraseVault](https://github.com/christcb03/phrasevault)** — a separate platform for signed nodes, forest links, PVFS (file abstraction), and append-only replication shared across applications.

This document describes the **target architecture** (how the system should be structured). A short section at the end lists **current implementation gaps** in this repo. For operational deployment, see [deploy/DEPLOYMENT.md](../deploy/DEPLOYMENT.md).

**Naming note:** *MediaVault* may be a better product name later (vault of media on PhraseVault). The repository and packages remain `mediaforest` until a deliberate rename.

Related docs:

- [Libraries, sections, and staging (interim features)](LIBRARIES-AND-SECTIONS.md)
- [Plex sync design](PLEX-SYNC.md)
- [PVFS API wishlist for PhraseVault](PVFS-API-WISHLIST.md) — copy into the platform repo

---

## What you are building

One **forest** (a single graph of signed **PVNodes** and **links** between them). Many **trees** (different **root** nodes for different purposes). Three ideas to keep separate:

1. **Files** — what bytes exist and where they live (**PVFS**).
2. **Titles** — what a work is (movie, episode, metadata) (**title nodes** in the catalog).
3. **Shelves** — how each user organizes and browses titles (**collection trees**).

PhraseVault owns the forest machinery and PVFS. MediaForest owns media meaning (matching, Plex/TMDB, ingest workflows, UI). **Ingest state** (scan jobs, staged imports, match review) is **not** PVFS — it lives in the app until optionally modeled as app-specific nodes.

---

## Terms and definitions

| Term | Meaning |
|------|---------|
| **PhraseVault (PV)** | Platform: sign and store PVNodes, forest links, PVFS, append-only sync. |
| **MediaForest** | This media app (future name: MediaVault). |
| **PVNode** | A signed record: `id`, `type`, `author`, `payload`, `links[]` (see `src/node/types.ts`). |
| **Forest** | All PVNodes plus **forest links** (parent → child edges, e.g. `/forest/link` in PhraseVault). |
| **Tree** | Everything reachable from one **root** by following forest links. |
| **Root** | The top node of a tree (`PVFS_primary_root`, `collection:movies`, `config:{pubKey}`, …). |
| **Forest link** | A navigational edge: `parent_id` → `child_id`, with a `link_type` (e.g. `member`, `next`, `prev`). |
| **Node `links[]`** | Dependencies inside the signed node (e.g. a file reference node lists its title node id). Related to forest links but not the same thing. |
| **Append-only log** | An ordered, replicated stream of node updates (Hypercore-style). Used to **sync** between machines — not how you browse “Movies.” |
| **PVFS** | The **file** side of the system: content hash, size, mime, **locations** (`file://` today; remote/torrent later). |
| **Primary PVFS tree** | **Server owner’s** canonical ordered inventory of files on server disk or native mounts. |
| **User PVFS tree** | Per-member tree: their files, or **references** into the primary tree / remote PVFS servers. |
| **Title node** | Catalog node for one work (`type: media` in code today): title, year, kind, external ids, poster, genres. |
| **File reference node** | Catalog node linking a title to a PVFS file node id (`storage_pointer` in code today). |
| **Collection** | Per-user tree root for any shelf (Movies, Horror, Unwatched, Watchlist, …): **member links** to title node ids only. |
| **Config tree** | Per-user settings (providers, home sections, preferences). |

**Rule of thumb:** PVFS knows **files**. The app knows **workflows and meaning**. Forest trees are how you **organize and browse**.

---

## How the pieces relate

**Title nodes** hold the facts about a work. **Collection trees** only point at title nodes — they do not duplicate title metadata. **File reference nodes** connect a title to a **PVFS file node**. **Collections** answer “what’s on this shelf?”; title nodes answer “what is this movie?”; PVFS answers “where are the bytes?”

```
  collection:movies ----member link---->  title node (Iron Man)
  collection:horror ---member link---->  title node (Iron Man)   [same title, two shelves]

  title node (Iron Man) ---> file reference node ---> PVFS file node ---> location file:///...
```

A title node can appear in many collections. A title node can have one or more file references (e.g. 1080p and 4K files). One PVFS file node can be referenced by multiple file references only if you intentionally share the same file across titles (unusual); normally one file node per distinct file on disk.

**Watchlist / Unwatched / Genre:** use the **same collection mechanism** as Movies — different roots (`collection:watchlist`, `collection:unwatched`, `collection:genre-horror`). Watch progress can live on the member link payload or a small watch-state node tied to the user + title.

---

## Structure 1 — Primary PVFS tree (server owner)

**Owner:** the server owner (one primary tree per MediaForest deployment).

**Purpose:** every media file physically available on the server — local disk or native filesystem mounts (e.g. `/media` in Docker).

**Shape:**

```
PVFS_primary_root
  -> file_node_1 <-> file_node_2 <-> file_node_3   (prev / next ordering)
       | location: file:///path/to/file.mkv
       | location: (optional additional URIs later)
```

1. **Root** — entry to the server’s canonical file inventory.
2. **File nodes** — one per ingested file; payload holds content hash, size, mime, label.
3. **Ordering** — siblings linked with `prev` / `next` (or equivalent) so the tree can be walked in stable order (scan order, path sort, etc.).
4. **Location** — where bytes live on the server (`file://` today). Attached to the file node (payload field or child link per PhraseVault PVFS schema).

**Not in primary PVFS:** scan job progress, TMDB match confidence, library membership, watch status, user accounts — all **MediaForest app** concerns.

---

## Structure 2 — User PVFS trees (members)

**Owner:** each registered user.

**Purpose:** files that user adds outside the shared server library — uploads, personal mounts, or (future) remote PVFS file servers.

Each entry is either:

- A **new file node** in that user’s tree (they own the ingest), or
- A **reference** to a node on the **primary PVFS tree** (same bytes, no duplicate hash on disk), or
- A **reference** to a file node on another **PVFS file server** when distributed PVFS exists (torrent-like sharing).

So the server maintains one ground-truth inventory for shared storage; members attach without copying when they use files already on the server.

---

## Structure 3 — Catalog nodes (titles and file references)

These are **canonical records** in the forest — **not** collections.

| Node kind | Holds | Does not hold |
|-----------|--------|----------------|
| **Title node** | Title, year, kind, TMDB/IMDB/TVDB ids, genres, poster, season/episode fields | Shelf membership, watch state, file paths |
| **File reference node** | Title node id, PVFS file node id, encoding, container, availability | Duplicate title metadata |
| **Crosslink** | Pointer to another user’s file reference (shared access without copying files) | — |
| **Watch state** (optional) | Per-user progress, watched/unwatched | File bytes; use link payload or dedicated small node |

Playback path: **collection** → **title node** → **file reference** → **PVFS file node** → **location** → stream (target: PVFS streaming service, not app-specific URLs).

---

## Structure 4 — Per-user collection trees

**Unified model:** Movies, TV, Genre, Watchlist, Unwatched, “Continue watching” shelves are all the **same structure** — a **collection root** with **member** forest links to title node ids.

- Root id examples: `collection:movies`, `collection:tv`, `collection:watchlist`, `collection:unwatched`
- Member link: `parent` = collection root, `child` = title node id, optional `sort_key` for row order
- No `library` field on title nodes in the target model — membership is **only** via collection links

**Home page sections** (forward model): each user’s **config tree** holds **section** nodes that either:

- Point at a collection root (`collection:movies`), or
- Apply a filter that resolves to a collection walk

Shared **library definitions** (display name, color, default scan path template) may still be defined under the **owner’s server policy** so all users see consistent labels — but **which titles appear on a shelf** is per-user collection membership unless you later add shared collections by policy.

---

## Structure 5 — Per-user config trees and owner server branch

**Every user** has a config root, e.g. `config:{pubKey}`:

- TMDB / Plex credentials
- Home section layout (pointers to collections or filters)
- UI preferences

**Only the owner** has these children under **their** config root:

| Child | Who can edit | Contents |
|-------|----------------|----------|
| **server_policy** | Owner | Registration open/closed; optional shared library **definitions** (name, color, default path template) |
| **registered_users** | Owner | Roster of accounts on this MediaForest server (names, pubkeys, roles metadata) |

Members edit **their own** config and collections; they do **not** edit `server_policy` or `registered_users`.

See [Authentication and accounts](#authentication-and-accounts) for how login sessions relate to `registered_users`.

---

## Authentication and accounts

MediaForest uses **two separate auth layers**. Do not mix them.

### Layer A — MediaForest server ↔ PhraseVault

- The MediaForest **process** has its own secp256k1 **service identity** (in `server_key.json` today).
- It registers with PhraseVault (`POST /auth/register`) and uses challenge/response to obtain a **PV service token** for PVFS and forest APIs.
- This is **machine auth**, not end-user auth. See `PhraseVaultClient` in `src/pv/client.ts`.

### Layer B — Human user ↔ MediaForest

- Each person has a **user identity**: compressed secp256k1 **public key** (66 hex chars), derived from passphrase (browser/companion) or held in the companion app.
- **Registration** (`POST /auth/register`): client sends `pubKey`; first user becomes **owner**, others become **member** (open registration or invite token when closed).
- **Login** (`/auth/challenge` + `/auth/verify`): client signs a nonce with the **auth key** (BLAKE3-derived, browser-safe — same domain tags as `src/auth/index.ts`).
- **Password login** (`/auth/login-password`): verifies **argon2id** `recoveryPasswordHash` on the user record; issues session without rotating identity key. Should require **display name** when multiple users have passwords (target hardening).
- **Recovery** (`/auth/recover`): recovery password + new `pubKey`; must migrate `userSettings` / config tree to the new key in target model.

### What lives where (target)

| Data | Store | Ephemeral? | Who manages |
|------|--------|------------|-------------|
| **User identity** | Client (companion) or passphrase-derived | No | User |
| **Registered roster** | Owner config tree → `registered_users` | No | Owner only |
| **Role (owner/member)** | Entry in `registered_users` | No | Owner (first registrant is owner) |
| **Recovery password hash** | Per-user record (forest or interim `server_key.json`) | No | User / owner reset |
| **Session token** | MediaForest in-memory map (`sessions`) | Yes (24h TTL) | MediaForest API |
| **Invite token** | Interim `invites.json`; target: optional forest node or short-lived app store | Yes (e.g. 7 days) | Owner creates via `/auth/invite` |
| **Registration mode** | Owner `server_policy` child | No | Owner |
| **PV service token** | `PhraseVaultClient` in MF process | Yes (refresh on 401) | MediaForest server |

**Sessions are not PVNodes.** They are deployment-scoped bearer tokens so the browser does not re-sign every API call. Restarting MediaForest clears sessions; users sign in again. The **roster** of who may sign in persists in the owner’s `registered_users` branch (target) or `server_key.json` (today).

**Invites** gate registration in closed mode only. An invite does not create an account by itself — the user still completes `/auth/register` with their `pubKey`. Target: invites can remain app-local (simple, expiring) or become signed nodes under `server_policy`.

### Registration flow (closed mode)

```
  Owner -> MF: POST /auth/invite -> invite token
  Owner shares token out-of-band
  Member -> MF: POST /auth/register { pubKey, inviteToken, name?, recoveryPassword? }
  MF validates token, appends user to roster, adds config:{pubKey} + empty collection roots (target)
  Member -> MF: /auth/verify or login-password -> session token
```

### Relation to PVFS trees

- **Primary PVFS tree** is owned by the **server owner identity**, not by each member’s pubkey.
- **User PVFS trees** are keyed by **member pubKey**; members reference primary file nodes they are allowed to play (policy TBD: all members on shared server vs explicit grants).

### Interim vs target (auth)

| Concern | Today | Target |
|---------|-------|--------|
| User list | `server_key.json` → `users[]` | Owner `registered_users` in forest |
| Sessions | In-memory `Map` in `src/server/index.ts` | Same (app layer) or optional Redis for multi-instance |
| Invites | `invites.json` | App-local or forest-backed |
| Server ↔ PV | `PhraseVaultClient.authenticate()` | Unchanged |

---

## Structure 6 — Append-only sync (PhraseVault core)

**Role:** replicate signed node updates and link changes between peers — **transport**, not **browse structure**.

- **Target:** append-only replication is part of **PhraseVault core**; MediaForest (and other apps) consume it.
- **Browse/organize:** forest trees (PVFS, collections, config).
- **Future distributed PVFS:** blob availability replicates on the file network; metadata and link deltas replicate on the append-only log.

Do not treat the sync log as “the Movies library.” Users browse **collection trees** and query indexes built from forest walks.

---

## Example walkthrough

1. **Owner scans** `/media/Movies` → new **file nodes** appended to the **primary PVFS tree** (ordered list + `file://` locations).
2. **Import** (app workflow) → create **title node** + **file reference** pointing at the PVFS file node id; TMDB enrichment happens in the app.
3. **User adds to Movies** → add a **member** forest link from `collection:movies` (their root) to the title node id.
4. **Playback** → resolve file reference → PVFS location → stream via PVFS (with auth delegated from MediaForest session).

---

## Forest of trees — why this shape

1. **One file, many views** — one PVFS file node; many collections can reference the same title node.
2. **Config is data** — settings and user roster are PVNodes in the forest, not ad hoc JSON files.
3. **Clear ground truth** — bytes on primary PVFS; titles in catalog nodes; shelves in collection trees.
4. **Per-user UX without duplicating files** — each user has config + collections; shared disk inventory stays on the owner’s primary PVFS tree.

---

## Open design choices (not fixed yet)

- Exact `link_type` names in PhraseVault (`member`, `prev`, `next`, `pvfs_ref`, `server_policy`, …).
- Watch state: dedicated nodes vs payload on collection member links.
- Whether shared “server libraries” are only templates or also pre-built collection roots copied per user.
- PVFS streaming API shape and how MediaForest sessions authorize range requests.

---

## Current implementation gaps

This repository **does not yet** implement the target model end-to-end. Today:

| Target | Current gap |
|--------|-------------|
| Forest-first catalog | Title/file nodes live in a **local Hypercore feed** under `MF_DATA_DIR/feeds/` |
| Append-only sync in PhraseVault core | **Hypercore + Hyperswarm** run inside MediaForest (`src/store/hypercore.ts`, `src/replication/manager.ts`) |
| Config / user roster trees | **`server_key.json`** + in-memory sessions |
| Collection trees | **`library` field** on media payload + sections in `userSettings` JSON |
| Primary PVFS ordered tree | MF uses **`POST /pvfs/ingest`** + dedup via **`GET /pvfs/locations`**; stream proxied from PV |
| Per-user PVFS trees | Not implemented |
| Streaming via PVFS | **`GET /stream/:nodeId`** on MediaForest resolves PV metadata and reads local disk |
| Ingest / scan jobs | **MediaForest API** (`/pvfs/scan`, in-memory jobs) — correct layer, interim API |
| Forest link API | Present on **`PhraseVaultClient`** but not used for catalog/config |

Code names today: `type: media` (title node), `storage_pointer` (file reference), `MediaPayload` in `src/relay/types.ts` (includes interim `library` / `tags` fields).

---

## Potential issues and improvement ideas

Issues and improvements below apply to **moving toward** the target architecture and to **current code** quality.

### Architecture alignment

- Duplicate TMDB/Plex config in `server_key.json` and PhraseVault `/config/providers`.
- Streaming and file hashing implemented in MediaForest instead of PVFS services.
- Catalog in Hypercore while forest APIs exist but are unused — risk of two divergent graphs.
- `storage_pointer.endpoint_url` uses MediaForest `/stream/...` instead of PVFS-native URLs.

### Security and correctness

- Client `deriveAuthPrivKey` missing invalid-key rehash that server `src/auth/index.ts` performs.
- Password login without username when multiple users have recovery passwords.
- `/auth/recover` does not migrate `userSettings` when pubkey changes.
- `server_key.json` / `invites.json` written without atomic replace or locking.

### Performance and maintainability

- `RelayQueryEngine.refresh()` rebuilds the full index on every feed append.
- Batch import dedup scans entire catalog per item.
- `src/server/index.ts` is a single large module (~1.7k lines).
- No automated tests in CI; client eslint failures.

### Suggested direction (phased)

1. **Document and implement collection links** — stop writing `library` on new title nodes; migrate shelves to per-user collection roots.
2. **Move config + `registered_users` into owner/member config trees** — shrink `server_key.json` to bootstrap or remove it.
3. **PVFS primary tree** in PhraseVault — ordered file nodes; MediaForest ingest calls PV only for file registration.
4. **Per-user PVFS trees** with references into primary (and later remote) file nodes.
5. **Lift append-only replication** into PhraseVault core; MediaForest becomes a consumer.
6. **Materialized index** in MediaForest fed by forest/link events (keep fast search UI).

### PhraseVault platform (external repo)

Detailed HTTP contract: **[PVFS-API-WISHLIST.md](PVFS-API-WISHLIST.md)** (primary tree, user trees, ingest, stream, dedup).

Summary: PVFS scan/ingest jobs, ordered primary walk, range streaming with delegated MF auth, location verify, later distributed blob replication.

---

## Module map (this repository)

| Path | Role in target model |
|------|----------------------|
| `src/node/`, `src/crypto/`, `src/identity/` | PVNode signing (platform schema) |
| `src/auth/` | MediaForest login sessions (app); same challenge pattern as PV |
| `src/relay/` | Title / file reference / crosslink / watchlist node builders + query engine |
| `src/store/`, `src/replication/` | **Interim** Hypercore sync (target: PhraseVault core) |
| `src/pv/` | HTTP adapter to PhraseVault |
| `src/scan/`, `src/plex/` | App workflows (parse, match, Plex) |
| `src/server/` | HTTP API and orchestration |
| `client/` | React UI |

---

## Environment reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `MF_DATA_DIR` | `./data` | Data directory (feeds, `server_key.json` today) |
| `MF_PV_URL` | `http://localhost:8081` | PhraseVault base URL |
| `MF_MEDIA_DIR` | `""` | Optional media root hint |
| `MF_PORT` / `MF_HOST` | `8080` / `0.0.0.0` | HTTP bind |
| `MF_OPEN_REGISTRATION` | unset (= open) | Set `false` to force closed registration |

PhraseVault must run in **service mode** (no `PV_PASSPHRASE` gate) so MediaForest can register its server identity key. See [deploy/DEPLOYMENT.md](../deploy/DEPLOYMENT.md).