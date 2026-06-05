# Factory reset (owner only)

Wipes **all server-side data for every user** on this MediaForest deployment. Use when you want a clean catalog and registrations without reinstalling containers.

**This does not delete your media library files on disk or NAS.** Ingest only registers paths (`file://…`); reset removes those registrations in MediaForest and PhraseVault, not the video files under `/media` (or your host mount). You can scan and import again afterward.

---

## Who can run it

Only the account with **`role: owner`**, from **Settings → Factory reset (entire server)**.

---

## Safeguards (UI)

1. **Load impact preview** — counts catalog nodes, members, invites, staged imports, followed feeds, libraries.
2. Type exactly: **`DELETE ALL MEDIA DATA`**
3. Check all three acknowledgements:
   - Irreversible
   - Delete all member accounts and invites
   - Clear PhraseVault registrations and PVFS store (not library files on disk)
4. Browser confirm dialog (last chance)
5. **Factory reset server**

If anything fails, the UI should show a **specific** error (not only “Internal Server Error”). Common cause: PhraseVault image missing `POST /admin/factory-reset` — redeploy PhraseVault first.

---

## What is removed

| Data | Location |
|------|----------|
| Shared media catalog (titles, file refs, watchlists in feed) | `MF_DATA_DIR/feeds/<server-identity>/` (Hypercore recreated empty) |
| All **member** users + pending invites | `server_key.json`, `invites.json` |
| Per-user settings (owner TMDB key, sections, etc.) | `server_key.json` `userSettings` |
| Library definitions | `server_key.json` `libraries` |
| Staged import batches | `staged_imports.json` |
| Followed remote feeds | `followed.json` + replication state |
| All login sessions | in-memory (everyone must sign in again) |
| PVFS file nodes, locations, trees, scan jobs | PhraseVault `forest.db` + `pvfs/` store copies |

---

## What is kept

| Item | Notes |
|------|--------|
| **Owner account** | Same pubkey; you can log in again after reload |
| **Server identity key** | `server_key.json` `identityPrivKey` unchanged |
| **Files on disk/NAS** | `file://` paths untouched |
| **PhraseVault server identity** | PV `server_key.json` unchanged |

---

## Execution order (server)

1. **PhraseVault** `POST /admin/factory-reset` (metadata + PVFS store blobs only).
2. If PV fails → **abort**; MediaForest catalog is not torn down.
3. Clear staged imports, members, invites, settings, sessions.
4. Delete and recreate the local Hypercore catalog feed.

---

## HTTP API (MediaForest)

Bearer token required. Owner role only.

| Method | Path | Body |
|--------|------|------|
| GET | `/admin/factory-reset/preview` | — |
| POST | `/admin/factory-reset` | See below |

```json
{
  "confirmation_phrase": "DELETE ALL MEDIA DATA",
  "acknowledge_irreversible": true,
  "acknowledge_remove_all_members": true,
  "acknowledge_remove_pvfs_inventory": true
}
```

Response includes a `summary` (members removed, feeds cleared, PhraseVault result, new catalog feed key).

---

## PhraseVault dependency

MediaForest calls PhraseVault (internal URL `MF_PV_URL`, e.g. `http://phrasevault:8081`) with the same confirmation phrase. PhraseVault must expose:

| Method | Path |
|--------|------|
| GET | `/admin/factory-reset/preview` |
| POST | `/admin/factory-reset` |

Documented in [PhraseVault docs/DEPLOY.md](https://github.com/christcb03/phrasevault/blob/main/docs/DEPLOY.md).

Deploy **both** images after upgrading reset support.

---

## Per-file delete vs factory reset

| Action | Scope | Disk `file://` |
|--------|--------|----------------|
| **Factory reset** | Entire server catalog + PV metadata | Not deleted |
| **Remove from primary tree** (`DELETE /pvfs/trees/primary/files/:id` on PV) | One file; cascade soft-links; optional `confirm_local_delete` | Only if you explicitly confirm |

---

## After reset

1. Reload the browser and sign in as owner.
2. Re-enter TMDB and Plex settings if needed.
3. Re-create libraries and re-scan `/media` to rebuild the catalog.