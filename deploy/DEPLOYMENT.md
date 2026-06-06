# Deployment

## Server

**presubuntu** — `192.168.0.184` (public IP: `95.216.117.242`)

This is the only server for MediaForest and PhraseVault. Do not deploy these to mediabox (192.168.1.142), which is the Saltbox/Plex/arr server.

## Stack

Both services run as Docker containers on the `saltbox` external network, behind Traefik with Cloudflare DNS-challenge TLS.

| Service | URL | Compose file on server |
|---------|-----|------------------------|
| MediaForest | https://mediaforest.turnernetworking.com | `/home/chris/mediaforest/docker-compose.yml` |
| PhraseVault | https://pvtest.turnernetworking.com | `/home/chris/phrasevault/docker-compose.yml` |

PhraseVault data persists at `/opt/phrasevault/data` on the host. MediaForest data persists at `/home/chris/mediaforest/data`.

## CI/CD Pipeline

```
git push origin main  (per repo)
  → GitHub Actions (.github/workflows/docker.yml)
  → builds ghcr.io/christcb03/<repo>:latest
  → pushes to GHCR
  → Watchtower on presubuntu polls every 300s
  → detects new digest → pulls → restarts labeled container
  → optional Telegram notification
```

| Repo | Image | Auto-update on presubuntu |
|------|-------|---------------------------|
| mediaforest | `ghcr.io/christcb03/mediaforest:latest` | Yes (public GHCR) |
| phrasevault | `ghcr.io/christcb03/phrasevault:latest` | Yes if Watchtower has GHCR creds; else manual pull |

## First-time Setup (new server)

1. Ensure the `saltbox` Docker network exists: `docker network create saltbox` (Saltbox does this automatically)
2. Create data dirs: `sudo mkdir -p /opt/phrasevault/data && sudo chown -R 1000:1000 /opt/phrasevault/data`
3. Deploy PhraseVault first (MediaForest depends on it):
   ```
   mkdir -p /home/chris/phrasevault
   cp deploy/docker-compose.phrasevault.yml /home/chris/phrasevault/docker-compose.yml
   cd /home/chris/phrasevault && docker compose up -d
   ```
4. Deploy MediaForest:
   ```
   mkdir -p /home/chris/mediaforest
   cp deploy/docker-compose.mediaforest.yml /home/chris/mediaforest/docker-compose.yml
   cd /home/chris/mediaforest && docker compose up -d
   ```
5. Verify: `docker ps` — both containers should be `(healthy)` within ~30 seconds

## Key Notes

- **PhraseVault must run without `PV_PASSPHRASE`** (service mode). If passphrase mode is active, MediaForest cannot register its secp256k1 auth key and all storage operations will fail.
- **MediaForest GHCR package is public** — no Docker auth needed on the host.
- **PhraseVault GHCR** — if Watchtower cannot pull (private package), manual: `cd /home/chris/phrasevault && docker compose pull && docker compose up -d`. See also [phrasevault docs/DEPLOY.md](https://github.com/christcb03/phrasevault/blob/main/docs/DEPLOY.md).
- Watchtower (`watchtower-phrasevault` container) only monitors containers with `com.centurylinklabs.watchtower.enable=true` label.
- Media library is mounted read-only from `/mnt/unionfs/Media` into both containers as `/media`.
  - For the admin local delete feature (`/admin/local-storage/delete` in Forest page), you must change the volume to read-write (remove `:ro`) and ensure the container's node user (UID 1000) has write permission on the host mount. Use with caution — there is no trash or undo, and it only affects local mounts (remote storage deletes are not supported).

## Factory reset (owner)

The owner can wipe **all server metadata** from the MediaForest UI (Settings). That calls MediaForest `POST /admin/factory-reset`, which in turn calls PhraseVault `POST /admin/factory-reset`.

**Requires both containers on builds that include admin factory-reset** (PhraseVault `1fbb2cc+`, MediaForest `6dd388b+` with subsequent fixes).

**Does not delete files under `/mnt/unionfs/Media`** — only catalog, users (except owner), invites, and PVFS/forest DB state.

See [docs/FACTORY-RESET.md](../docs/FACTORY-RESET.md) and [PhraseVault docs/ADMIN-FACTORY-RESET.md](https://github.com/christcb03/phrasevault/blob/main/docs/ADMIN-FACTORY-RESET.md).

## Watchtower update failed (zombie process)

If Telegram reports **MediaForest update failed** but GitHub Actions succeeded, check Watchtower logs:

```bash
docker logs watchtower-phrasevault --tail 20
```

Common error: `PID … is zombie and can not be killed` — the Node process did not exit cleanly on SIGTERM. Fix:

```bash
cd /home/chris/mediaforest
docker rm -f mediaforest
docker compose pull && docker compose up -d
```

Ensure `docker-compose.yml` includes `init: true` under the `mediaforest` service (see `deploy/docker-compose.mediaforest.yml`).

## After reboot (site down / Cloudflare 521)

Saltbox runs `sb install core` on boot maintenance, which **stops Docker** while remounting rclone/NAS paths. If Docker is not brought back up afterward, Traefik and all apps stay down (Cloudflare **521**).

**Check on presubuntu:**

```bash
systemctl is-active docker          # should be "active"
docker ps --format 'table {{.Names}}\t{{.Status}}' | egrep 'traefik|mediaforest|phrasevault'
curl -s https://mediaforest.turnernetworking.com/health
```

**Quick fix:**

```bash
sudo systemctl start docker.socket docker.service
sb docker start                     # starts Saltbox-managed containers (Traefik, MF, PV, …)
docker start watchtower-phrasevault # if exited
```

**Boot safety net:** `ensure-docker-stack.service` + timer (12 min after boot) on presubuntu re-starts Docker and runs `sb docker start` if Saltbox left Docker stopped. Script: `/usr/local/bin/ensure-docker-stack.sh`.

Docker is `enabled` and containers use `restart: unless-stopped`, but they cannot restart while the Docker daemon itself is stopped.

## Manual Re-deploy

```bash
# MediaForest only (Watchtower handles this automatically)
cd /home/chris/mediaforest
docker compose pull && docker compose up -d

# PhraseVault (manual only — private image)
cd /home/chris/phrasevault
docker compose pull && docker compose up -d
```
