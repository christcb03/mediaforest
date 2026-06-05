# PVFS API wishlist (PhraseVault)

One-page contract sketch for the **[PhraseVault](https://github.com/christcb03/phrasevault)** repo. **MediaForest** is the first consumer. Full target model: [ARCHITECTURE.md](ARCHITECTURE.md).

**PhraseVault status (2026-06):** P0 file-layer APIs are implemented on `main`. Canonical reference: [phrasevault `docs/PVFS-HTTP-API.md`](https://github.com/christcb03/phrasevault/blob/main/docs/PVFS-HTTP-API.md). Deploy: push `phrasevault` `main` → `ghcr.io/christcb03/phrasevault:latest` → Watchtower on presubuntu.

---

## Role of PVFS

PVFS is the **file layer**: content-addressed metadata, ordered inventory, locations, streaming bytes. It does **not** own titles, TMDB matching, scan-job UX, library shelves, or MediaForest login sessions.

```
  MediaForest app          PhraseVault PVFS              Host disk
  ----------------         ----------------              ---------
  title + file-ref nodes   primary PVFS tree  -------->  file://...
  collection trees         user PVFS trees    --ref-->  primary nodes
  ingest / match workflows   stream + hash
```

---

## Already used by MediaForest (baseline)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/pvfs/file` | Create file node (hash, size, mime, label) |
| GET | `/pvfs/file/:id` | Metadata + locations |
| POST | `/pvfs/file/:id/location` | Attach `file://` (or other) URI |
| GET | `/pvfs/locations` | Flat list — interim; replace with tree walk |

Forest (for future config/catalog in PV): `/forest/roots`, `/forest/node`, `/forest/link`, `/forest/walk/:id`.

---

## Target PVFS model

### Primary tree (server owner)

One root per deployment (`PVFS_primary_root`). Children form an **ordered list**:

- **File nodes** — payload: `content_hash`, `size_bytes`, `mime_type`, `original_filename`, `label`
- **Forest links** — `next` / `prev` between siblings; root → first node
- **Location** — on node payload or child link: `uri`, `type` (`local`, later `remote`, `torrent`)

### User trees (members)

Per-user root (`PVFS_user:{pubKey}`). Entries:

| Entry type | Meaning |
|------------|---------|
| **Owned file node** | User ingested bytes they control |
| **Reference link** | `link_type: pvfs_ref` → node id on **primary** tree (no re-hash) |
| **Remote ref** (future) | → file node on another PVFS server id |

---

## Endpoint status

Priority: **P0** = blocks MediaForest migration; **P1** = scale/ops; **P2** = distributed future.

Status: **done** = on PhraseVault `main`; **partial** = different path or subset; **—** = not yet.

### Inventory and trees

| Priority | Status | Method | Path | Purpose |
|----------|--------|--------|------|---------|
| P0 | done | GET | `/pvfs/trees/primary` | Root id + file count |
| P0 | done | GET | `/pvfs/trees/primary/walk` | Ordered files (`offset`, `limit`) |
| P0 | done | GET | `/pvfs/trees/user/:pubKey` | User tree + `pvfs_ref` refs |
| P0 | done | POST | `/pvfs/trees/user/:pubKey/ref` | Body: `{ primary_file_node_id }` |
| P0 | done | DELETE | `/pvfs/trees/primary/files/:id` | Cascade soft-delete; optional `confirm_local_delete` for `file://` disk |
| P0 | done | GET | `/pvfs/trees/primary/files/:id/remove-preview` | Preview cascade + local paths |
| P0 | done | GET | `/pvfs/orphans` | Orphan `pvfs.file` list |
| P0 | done | POST | `/pvfs/orphans/purge` | App-initiated hard-delete (`file_node_ids` optional) |
| P1 | — | GET | `/pvfs/file/:id/neighbors` | `prev` / `next` for list UI |

### Ingest and hashing (platform)

| Priority | Status | Method | Path | Purpose |
|----------|--------|--------|------|---------|
| P0 | done | POST | `/pvfs/ingest` | Body: `{ path, label?, mime_type? }` on server filesystem |
| P0 | done | POST | `/pvfs/scan` | Body: `{ path, dry_run?, extensions?, limit?, compute_hash? }` → `{ jobId }` |
| P0 | done | GET | `/pvfs/scan/:jobId` | Job status (SQLite-persisted) |
| P0 | done | GET | `/pvfs/scan` | Recent job summaries |
| P1 | partial | GET | `/pvfs/file/:id/verify?uri=` | BLAKE3 verify (GET today; POST + `last_verified` update later) |

MediaForest keeps **match review, TMDB, staged import** on its API — only **file registration** moves here.

### Streaming

| Priority | Status | Method | Path | Purpose |
|----------|--------|--------|------|---------|
| P0 | partial | GET | `/pvfs/file/:id/stream` | Ranges supported; wishlist path was `/pvfs/stream/:id` |
| P0 | — | HEAD | `/pvfs/file/:id/stream` | Length / accept-ranges probe |
| P1 | — | POST | `/pvfs/stream/:id/authorize` | MF session → short-lived token |

MediaForest today: `GET /stream/:nodeId` locally — migrate to PV stream URL + MF proxy or authorize.

### Dedup and references

| Priority | Status | Method | Path | Purpose |
|----------|--------|--------|------|---------|
| P0 | done | GET | `/pvfs/locations/by-uri?uri=` | Dedup by `file://` URI |
| P1 | — | GET | `/pvfs/file/:id/references` | Who linked this node |
| P1 | — | GET | `/pvfs/files/unreferenced?app=` | Files with no MF file-ref |

### Distributed (future)

| Priority | Method | Path | Purpose |
|----------|--------|------|---------|
| P2 | POST | `/pvfs/remote/register` | Register peer PVFS server |
| P2 | GET | `/pvfs/remote/:serverId/file/:id/stream` | Proxy stream from peer |

---

## Forest / platform (related, not only PVFS)

MediaForest also needs these in **PhraseVault core** (may share `/forest/*` today):

| Area | Need |
|------|------|
| **Append-only sync** | Replicate node + link writes (Hypercore today lives in MF repo — move to PV) |
| **Config trees** | CRUD under `config:{pubKey}`; owner children `server_policy`, `registered_users` |
| **Link types** | Register: `member`, `prev`, `next`, `pvfs_ref`, `config`, `server_policy` |

See [ARCHITECTURE.md — Structure 5 & 6](ARCHITECTURE.md#structure-5--per-user-config-trees-and-owner-server-branch).

---

## Auth expectations

| Caller | Auth |
|--------|------|
| MediaForest **server** → PV | Service identity: existing PV `/auth/challenge` + `/auth/verify` (server secp256k1 key) |
| Browser → PVFS stream | **Delegated**: MF session validated by MF; MF mints one-time token or PV trusts MF JWT |

PVFS should **not** implement MediaForest user registration or passphrase login.

---

## Explicitly not PVFS

- Scan **title parsing**, TMDB/Plex match, import staging batches
- **Title nodes**, **file reference nodes**, **collection** / **watchlist** trees
- MediaForest **Bearer sessions**, **invite tokens**, **argon2** recovery passwords
- **RelayQueryEngine** / home page section filters (app index over forest walks)

---

## PhraseVault — remaining platform work

1. **Append-only replication** API (Hypercore still in MediaForest).
2. **Config trees** — `config:{pubKey}`, `server_policy`, `registered_users` in forest.
3. P1: stream HEAD/alias, `orphaned_since`, neighbors, unreferenced query.
4. P2: remote PVFS servers.

---

## MediaForest migration (ready to start)

| MF today | Switch to |
|----------|-----------|
| `ingestFile()` local hash + `POST /pvfs/file` | `POST /pvfs/ingest` or scan job |
| `GET /pvfs/locations` in scan dedup | `by-uri` or primary walk |
| `GET /stream/:nodeId` | `GET /pvfs/file/:id/stream` on PV (or MF proxy + authorize) |
| Library delete | `DELETE /pvfs/trees/primary/files/:id` + confirm local disk in UI |
| Orphan cleanup | `GET /pvfs/orphans` → `POST /pvfs/orphans/purge` when user confirms |
| Owner factory reset | MF `POST /admin/factory-reset` → PV `POST /admin/factory-reset`; see [FACTORY-RESET.md](FACTORY-RESET.md) — **does not delete disk media** |
| File reference `endpoint_url` = `/stream/...` | Store PVFS file node id + PVFS stream URL template |

Consumer code: [src/pv/client.ts](../src/pv/client.ts), [src/server/index.ts](../src/server/index.ts).