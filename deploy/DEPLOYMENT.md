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
git push origin main
  → GitHub Actions (.github/workflows/docker.yml)
  → builds ghcr.io/christcb03/mediaforest:latest
  → pushes to GHCR (public package, no auth required to pull)
  → Watchtower on presubuntu polls every 300s
  → detects new digest → pulls → restarts mediaforest container
  → sends Telegram notification
```

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
- **PhraseVault GHCR package is private** — Watchtower cannot auto-update it without credentials. Manual pull: `docker compose pull && docker compose up -d` in `/home/chris/phrasevault/`.
- Watchtower (`watchtower-phrasevault` container) only monitors containers with `com.centurylinklabs.watchtower.enable=true` label.
- Media library is mounted read-only from `/mnt/unionfs/Media` into both containers as `/media`.

## Manual Re-deploy

```bash
# MediaForest only (Watchtower handles this automatically)
cd /home/chris/mediaforest
docker compose pull && docker compose up -d

# PhraseVault (manual only — private image)
cd /home/chris/phrasevault
docker compose pull && docker compose up -d
```
