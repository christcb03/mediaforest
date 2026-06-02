import Fastify from "fastify";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createReadStream } from "fs";
import { extname } from "node:path";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { identityFromPrivKey, generatePrivKey } from "../identity/index.js";
import {
  deriveAuthPubKey,
  createChallenge, consumeChallenge, verifyAuthSignature,
  createSession, verifySession,
} from "../auth/index.js";
import { HypercoreStore } from "../store/hypercore.js";
import { ReplicationManager } from "../replication/index.js";
import { RelayQueryEngine } from "../relay/query.js";
import {
  createMediaNode, createStoragePointerNode,
  createCrosslinkNode, createWatchlistEntryNode,
  MediaPayload, StoragePointerPayload, CrosslinkPayload, WatchlistEntryPayload,
} from "../relay/index.js";
import { PhraseVaultClient } from "../pv/client.js";
import { scanVideoFilesAsync } from "../scan/scan.js";
import { scoreCandidates } from "../scan/matcher.js";
import { blake3 } from "@noble/hashes/blake3";
import { createHash } from "node:crypto";

// ── Config from environment ────────────────────────────────────────────────

const DATA_DIR   = process.env.MF_DATA_DIR   ?? "./data";
const PORT       = parseInt(process.env.MF_PORT   ?? "8080", 10);
const HOST       = process.env.MF_HOST        ?? "0.0.0.0";
const LOG_LEVEL  = process.env.MF_LOG_LEVEL   ?? "info";
const PV_URL     = process.env.MF_PV_URL      ?? "http://localhost:8081";
const MEDIA_DIR  = process.env.MF_MEDIA_DIR   ?? "";

// ── Server key ─────────────────────────────────────────────────────────────

interface ServerKey {
  version: number;
  identityPrivKey: string;
  authPubKey: string | null;   // registered companion auth pubkey
}

const SERVER_KEY_PATH = path.join(DATA_DIR, "server_key.json");

function loadOrCreateServerKey(): ServerKey {
  if (existsSync(SERVER_KEY_PATH)) {
    return JSON.parse(readFileSync(SERVER_KEY_PATH, "utf-8")) as ServerKey;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const key: ServerKey = { version: 1, identityPrivKey: generatePrivKey(), authPubKey: null };
  writeFileSync(SERVER_KEY_PATH, JSON.stringify(key, null, 2), { mode: 0o600 });
  return key;
}

function saveServerKey(key: ServerKey): void {
  writeFileSync(SERVER_KEY_PATH, JSON.stringify(key, null, 2), { mode: 0o600 });
}

const serverKey = loadOrCreateServerKey();
const privKeyHex = serverKey.identityPrivKey;
const identity = identityFromPrivKey(privKeyHex);
const pubKeyHex = Buffer.from(identity.publicKey).toString("hex");

// ── PhraseVault client ─────────────────────────────────────────────────────

const pv = new PhraseVaultClient(PV_URL, privKeyHex);

// Register with PV and authenticate (non-fatal — server may start before PV)
async function connectToPV(): Promise<void> {
  try {
    await pv.register();
    await pv.authenticate();
    console.info(`[MF] Connected to PhraseVault at ${PV_URL}`);
  } catch (err) {
    console.warn(`[MF] Could not connect to PhraseVault: ${err}. Will retry on first request.`);
  }
}

// ── Auth state ─────────────────────────────────────────────────────────────

let AUTH_PUB_KEY: Uint8Array | null = serverKey.authPubKey
  ? Buffer.from(serverKey.authPubKey, "hex")
  : null;

const challenges = new Map<string, number>();
const sessions   = new Map<string, number>();

const PUBLIC_ROUTES = new Set(["/health", "/auth/challenge", "/auth/verify", "/auth/register"]);
const API_PREFIXES = [
  "/search", "/media", "/storage", "/crosslink", "/watchlist",
  "/follow", "/following", "/identity", "/auth", "/tmdb",
  "/pvfs", "/config", "/stream",
];

// ── Hypercore / relay ──────────────────────────────────────────────────────

const ownStore = new HypercoreStore(path.join(DATA_DIR, "feeds"), pubKeyHex);
await ownStore.open();

const replication = new ReplicationManager(path.join(DATA_DIR, "feeds"));
await replication.shareOwnFeed(ownStore);

const engine = new RelayQueryEngine();
engine.addFeed(pubKeyHex, ownStore);

const FOLLOWED_PATH = path.join(DATA_DIR, "followed.json");
const followedKeys: string[] = existsSync(FOLLOWED_PATH)
  ? JSON.parse(readFileSync(FOLLOWED_PATH, "utf-8"))
  : [];

for (const key of followedKeys) {
  const store = await replication.followFeed(key);
  engine.addFeed(key, store);
}

await engine.refresh();

// ── Fastify ────────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: LOG_LEVEL } });
await app.register(cors, { origin: true });

// ── Auth middleware ────────────────────────────────────────────────────────

app.addHook("onRequest", async (req, reply) => {
  const url = req.url.split("?")[0];
  if (PUBLIC_ROUTES.has(url)) return;
  const isApiRoute = API_PREFIXES.some(p => url === p || url.startsWith(p + "/"));
  if (!isApiRoute) return;
  if (!AUTH_PUB_KEY) {
    return reply.status(401).send({ error: "server not configured: companion must POST /auth/register first" });
  }
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ") || !verifySession(sessions, header.slice(7))) {
    return reply.status(401).send({ error: "unauthorized" });
  }
});

// ── Auth endpoints ─────────────────────────────────────────────────────────

app.get("/auth/challenge", async () => ({
  challenge: createChallenge(challenges),
}));

app.post<{ Body: { challenge?: string; signature?: string } }>("/auth/verify", async (req, reply) => {
  const { challenge, signature } = req.body ?? {};
  if (!challenge || !signature) return reply.status(400).send({ error: "missing fields" });
  if (!AUTH_PUB_KEY) return reply.status(401).send({ error: "server not configured: POST /auth/register first" });
  if (!consumeChallenge(challenges, challenge)) {
    return reply.status(401).send({ error: "invalid or expired challenge" });
  }
  if (!verifyAuthSignature(AUTH_PUB_KEY, challenge, signature)) {
    await new Promise(r => setTimeout(r, 200));
    return reply.status(401).send({ error: "invalid signature" });
  }
  return { token: createSession(sessions), identity: pubKeyHex };
});

app.post<{ Body: { pubKey?: string } }>("/auth/register", async (req, reply) => {
  if (AUTH_PUB_KEY) return reply.status(409).send({ error: "already registered" });
  const { pubKey } = req.body ?? {};
  if (!pubKey || !/^[0-9a-f]{66}$/.test(pubKey)) {
    return reply.status(400).send({ error: "pubKey must be a 33-byte compressed secp256k1 key in hex (66 chars)" });
  }
  serverKey.authPubKey = pubKey;
  saveServerKey(serverKey);
  AUTH_PUB_KEY = Buffer.from(pubKey, "hex");
  return { registered: true, serverIdentity: pubKeyHex };
});

// ── Health ─────────────────────────────────────────────────────────────────

app.get("/health", async () => ({
  status: "ok",
  identity: pubKeyHex,
  feedLength: ownStore.length,
  following: followedKeys.length,
  indexed: engine.size,
  pvUrl: PV_URL,
}));

// ── Identity ───────────────────────────────────────────────────────────────

app.get("/identity", async () => ({
  publicKey: pubKeyHex,
  feedKey: ownStore.feedKey.toString("hex"),
}));

// ── Search ─────────────────────────────────────────────────────────────────

app.get<{
  Querystring: { q?: string; kind?: string; available?: string; watchStatus?: string }
}>("/search", async (req) => {
  const { q, kind, available, watchStatus } = req.query;
  const results = engine.search({
    query: q,
    kind: kind as never,
    availableOnly: available === "true",
    watchStatus: watchStatus as never,
  });
  return { count: results.length, results: results.map(serializeResult) };
});

app.get<{ Params: { id: string } }>("/media/:id", async (req, reply) => {
  const result = engine.getById(req.params.id);
  if (!result) return reply.status(404).send({ error: "not found" });
  return serializeResult(result);
});

// ── Publish relay nodes ────────────────────────────────────────────────────

app.post<{ Body: MediaPayload }>("/media", async (req, reply) => {
  const node = await createMediaNode(privKeyHex, req.body);
  await ownStore.append(node);
  await engine.refresh();
  reply.status(201);
  return { id: node.id };
});

app.post<{ Body: StoragePointerPayload }>("/storage", async (req, reply) => {
  const node = await createStoragePointerNode(privKeyHex, req.body);
  await ownStore.append(node);
  await engine.refresh();
  reply.status(201);
  return { id: node.id };
});

app.post<{ Body: CrosslinkPayload }>("/crosslink", async (req, reply) => {
  const node = await createCrosslinkNode(privKeyHex, {
    ...req.body,
    added_at: req.body.added_at ?? Date.now(),
  });
  await ownStore.append(node);
  await engine.refresh();
  reply.status(201);
  return { id: node.id };
});

app.post<{ Body: WatchlistEntryPayload }>("/watchlist", async (req, reply) => {
  const node = await createWatchlistEntryNode(privKeyHex, {
    ...req.body,
    added_at: req.body.added_at ?? Date.now(),
  });
  await ownStore.append(node);
  await engine.refresh();
  reply.status(201);
  return { id: node.id };
});

app.patch<{
  Params: { mediaId: string };
  Body: { status?: string; progress_ms?: number };
}>("/watchlist/:mediaId", async (req, reply) => {
  const result = engine.getById(req.params.mediaId);
  if (!result) return reply.status(404).send({ error: "media not found" });
  const existing = result.watchlistEntry;
  const status = (req.body.status ?? existing?.payload.status ?? "unwatched") as import("../relay/types.js").WatchStatus;
  const node = await createWatchlistEntryNode(privKeyHex, {
    media_node_id: req.params.mediaId,
    crosslink_node_id: existing?.payload.crosslink_node_id ?? "",
    status,
    added_at: existing?.payload.added_at ?? Date.now(),
    progress_ms: req.body.progress_ms ?? existing?.payload.progress_ms,
    size_bytes: existing?.payload.size_bytes ?? 0,
    ...(status === "watched" ? { watched_at: Date.now() } : {}),
  });
  await ownStore.append(node);
  await engine.refresh();
  return { id: node.id, status };
});

// ── Follow / unfollow peers ────────────────────────────────────────────────

app.post<{ Body: { feedKey: string } }>("/follow", async (req, reply) => {
  const { feedKey } = req.body;
  if (followedKeys.includes(feedKey)) return reply.status(409).send({ error: "already following" });
  const store = await replication.followFeed(feedKey);
  engine.addFeed(feedKey, store);
  followedKeys.push(feedKey);
  writeFileSync(FOLLOWED_PATH, JSON.stringify(followedKeys));
  await engine.refresh();
  reply.status(201);
  return { following: feedKey };
});

app.delete<{ Params: { feedKey: string } }>("/follow/:feedKey", async (req) => {
  const { feedKey } = req.params;
  await replication.unfollow(feedKey);
  engine.removeFeed(feedKey);
  const idx = followedKeys.indexOf(feedKey);
  if (idx !== -1) followedKeys.splice(idx, 1);
  writeFileSync(FOLLOWED_PATH, JSON.stringify(followedKeys));
  await engine.refresh();
  return { unfollowed: feedKey };
});

app.get("/following", async () => ({ keys: followedKeys }));

// ── TMDB proxy (reads token from PV config) ───────────────────────────────

const TMDB_BASE = "https://api.themoviedb.org/3";

async function getTmdbToken(): Promise<string> {
  return pv.getTmdbToken();
}

function tmdbHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

app.get<{ Querystring: { q?: string } }>("/tmdb/search", async (req, reply) => {
  const token = await getTmdbToken();
  if (!token) return reply.status(503).send({ error: "TMDB not configured — add Read Access Token in Settings" });
  const { q } = req.query;
  if (!q) return reply.status(400).send({ error: "q is required" });
  const res = await fetch(`${TMDB_BASE}/search/multi?query=${encodeURIComponent(q)}&include_adult=false`, { headers: tmdbHeaders(token) });
  const data = await res.json() as { results?: Record<string, unknown>[] };
  const results = (data.results ?? [])
    .filter(r => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, 12)
    .map(r => ({
      tmdb_id: String(r.id),
      media_type: r.media_type as string,
      title: (r.media_type === "movie" ? r.title : r.name) as string,
      year: ((r.media_type === "movie" ? r.release_date : r.first_air_date) as string ?? "").slice(0, 4),
      poster_path: (r.poster_path as string | null) ?? null,
      overview: (r.overview as string | null) ?? null,
    }));
  return { results };
});

app.get<{ Querystring: { id?: string; type?: string } }>("/tmdb/details", async (req, reply) => {
  const token = await getTmdbToken();
  if (!token) return reply.status(503).send({ error: "TMDB not configured — add Read Access Token in Settings" });
  const { id, type } = req.query;
  if (!id || !type) return reply.status(400).send({ error: "id and type are required" });
  const segment = type === "tv" ? "tv" : "movie";
  const res = await fetch(`${TMDB_BASE}/${segment}/${id}?append_to_response=external_ids`, { headers: tmdbHeaders(token) });
  const d = await res.json() as Record<string, unknown>;
  const extIds = (d.external_ids ?? {}) as Record<string, unknown>;
  return {
    tmdb_id: String(d.id), media_type: type,
    title: (type === "movie" ? d.title : d.name) as string,
    year: ((type === "movie" ? d.release_date : d.first_air_date) as string ?? "").slice(0, 4),
    genres: ((d.genres as { name: string }[] | undefined) ?? []).map(g => g.name),
    imdb_id: (d.imdb_id ?? extIds.imdb_id ?? undefined) as string | undefined,
    tvdb_id: extIds.tvdb_id ? String(extIds.tvdb_id) : undefined,
    runtime_min: (type === "movie" ? d.runtime : (d.episode_run_time as number[] | undefined)?.[0]) as number | undefined,
    poster_path: (d.poster_path as string | null) ?? null,
    overview: (d.overview as string | null) ?? null,
  };
});

// ── PVFS scan (proxied to PV forest, local file hash) ──────────────────────

interface ScanJob {
  status: "running" | "done" | "error";
  startedAt: number; dry_run: boolean; found: number;
  new_count?: number; already_ingested_count?: number;
  files: unknown[]; ingested?: number; failed?: number;
  failures?: Array<{ path: string; error: string }>; error?: string;
}
const scanJobs = new Map<string, ScanJob>();

app.post<{ Body: { path: string; dry_run?: boolean; extensions?: string[]; limit?: number } }>(
  "/pvfs/scan",
  async (req, reply) => {
    const { path: dirPath, dry_run = true, extensions, limit } = req.body;
    if (!dirPath) return reply.status(400).send({ error: "path is required" });
    if (!existsSync(dirPath)) return reply.status(400).send({ error: `directory not found: ${dirPath}` });

    const jobId = randomBytes(16).toString("hex");
    const job: ScanJob = { status: "running", startedAt: Date.now(), dry_run, found: 0, files: [] };
    scanJobs.set(jobId, job);

    const extSet = extensions
      ? new Set(extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()))
      : undefined;

    ;(async () => {
      try {
        // Get already-ingested URIs from PV
        const ingestedUris = new Set<string>();
        try {
          const pvfsLocations = await pv.get<{ nodes: Array<{ payload: { uri: string } }> }>("/pvfs/locations");
          for (const n of pvfsLocations.nodes ?? []) {
            if (n.payload?.uri) ingestedUris.add(n.payload.uri);
          }
        } catch { /* PV not available, proceed without dedup */ }

        if (dry_run) {
          let count = 0;
          await scanVideoFilesAsync(dirPath, extSet, undefined, (file) => {
            if (limit && count >= limit) return;
            file.already_ingested = ingestedUris.has(`file://${file.path}`);
            (job.files as typeof file[]).push(file);
            count++;
            job.found = count;
            job.new_count = (job.files as typeof file[]).filter(f => !f.already_ingested).length;
            job.already_ingested_count = count - (job.new_count ?? 0);
          });
          job.status = "done";
          return;
        }

        const files = await scanVideoFilesAsync(dirPath, extSet, n => { job.found = n; });
        const batch = limit ? files.slice(0, limit) : files;
        for (const f of batch) f.already_ingested = ingestedUris.has(`file://${f.path}`);
        const newFiles = batch.filter(f => !f.already_ingested);
        job.new_count = newFiles.length;
        job.already_ingested_count = batch.length - newFiles.length;

        const ingested: Array<{ path: string; fileNodeId: string; contentHash: string }> = [];
        const failures: Array<{ path: string; error: string }> = [];

        for (const file of newFiles) {
          try {
            const { fileNode } = await ingestFile(file.path, { label: file.parsed.title || path.basename(file.path) });
            ingested.push({ path: file.path, fileNodeId: fileNode.id, contentHash: fileNode.payload.content_hash as string });
          } catch (err) {
            failures.push({ path: file.path, error: err instanceof Error ? err.message : "ingest failed" });
          }
        }

        job.files = ingested; job.ingested = ingested.length;
        job.failed = failures.length; job.failures = failures;
        job.status = "done";
      } catch (err) {
        job.error = err instanceof Error ? err.message : "scan failed";
        job.status = "error";
      }
    })();

    return reply.status(202).send({ jobId });
  },
);

app.get<{ Params: { jobId: string } }>("/pvfs/scan/job/:jobId", async (req, reply) => {
  const job = scanJobs.get(req.params.jobId);
  if (!job) return reply.status(404).send({ error: "job not found" });
  return reply.send(job);
});

// ── Media match (TMDB + confidence scoring) ───────────────────────────────

app.post<{ Body: { items: Array<{ title: string; year: number | null; kind: "movie" | "series" | "unknown" }>; threshold?: number } }>(
  "/media/match/search",
  async (req, reply) => {
    const token = await getTmdbToken();
    if (!token) return reply.status(503).send({ error: "TMDB not configured" });
    const { items, threshold = 0.8 } = req.body;
    if (!Array.isArray(items) || items.length === 0) return reply.status(400).send({ error: "items array is required" });

    const results = [];
    for (const item of items) {
      try {
        const mediaType = item.kind === "movie" ? "movie" : item.kind === "series" ? "tv" : "multi";
        const endpoint = mediaType === "multi"
          ? `${TMDB_BASE}/search/multi?query=${encodeURIComponent(item.title)}&include_adult=false`
          : `${TMDB_BASE}/search/${mediaType}?query=${encodeURIComponent(item.title)}&include_adult=false`;
        const res = await fetch(endpoint, { headers: tmdbHeaders(token) });
        const data = await res.json() as { results?: Record<string, unknown>[] };
        const raw = (data.results ?? [])
          .filter(r => r.media_type === "movie" || r.media_type === "tv" || mediaType !== "multi")
          .slice(0, 10)
          .map(r => {
            const isTv = mediaType === "tv" || r.media_type === "tv";
            return {
              tmdb_id: String(r.id), media_type: (isTv ? "tv" : "movie") as "movie" | "tv",
              title: (isTv ? r.name : r.title) as string ?? "",
              year: ((isTv ? r.first_air_date : r.release_date) as string ?? "").slice(0, 4),
              poster_path: (r.poster_path as string | null) ?? null,
              overview: (r.overview as string | null) ?? null,
            };
          });
        results.push(scoreCandidates(item, raw, threshold));
      } catch {
        results.push({ query: item, candidates: [], best: null, needs_review: true });
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return reply.send({ results, threshold });
  },
);

// ── Local artwork proxy ───────────────────────────────────────────────────

const ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

app.get<{ Querystring: { path: string } }>("/pvfs/artwork", async (req, reply) => {
  const filePath = req.query.path;
  if (!filePath) return reply.status(400).send({ error: "path is required" });
  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) return reply.status(400).send({ error: "not an image path" });
  if (!existsSync(filePath)) return reply.status(404).send({ error: "not found" });
  const mimeMap: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  reply.header("Content-Type", mimeMap[ext] ?? "image/jpeg");
  reply.header("Cache-Control", "public, max-age=86400");
  return reply.send(createReadStream(filePath));
});

// ── File streaming (via PV PVFS metadata + local file) ───────────────────

app.get<{ Params: { nodeId: string } }>("/stream/:nodeId", async (req, reply) => {
  let fileNode: Record<string, unknown>;
  try {
    fileNode = await pv.getPvfsFile(req.params.nodeId) as Record<string, unknown>;
  } catch {
    return reply.status(404).send({ error: "file node not found" });
  }

  const node = (fileNode as { node: Record<string, unknown> }).node ?? fileNode;
  const payload = node.payload as { content_hash: string; size_bytes: number; mime_type: string };
  const locations = ((fileNode as { locations?: Array<{ payload: { uri: string; type: string } }> }).locations ?? []);
  const local = locations.find(l => l.payload?.type === "local");

  let filePath: string | null = null;
  if (local?.payload.uri.startsWith("file://")) {
    filePath = local.payload.uri.slice("file://".length);
  }
  if (!filePath || !existsSync(filePath)) return reply.status(404).send({ error: "file not available locally" });

  const mimeType = payload.mime_type || "application/octet-stream";
  const totalSize = payload.size_bytes;
  const rangeHeader = req.headers["range"] as string | undefined;

  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", mimeType);

  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) return reply.status(416).send({ error: "invalid range" });
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
    if (start >= totalSize || end >= totalSize || start > end) {
      reply.header("Content-Range", `bytes */${totalSize}`);
      return reply.status(416).send({ error: "range not satisfiable" });
    }
    reply.status(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    reply.header("Content-Length", end - start + 1);
    return reply.send(createReadStream(filePath, { start, end }));
  }
  reply.header("Content-Length", totalSize);
  return reply.send(createReadStream(filePath));
});

// ── Static files + SPA fallback ────────────────────────────────────────────

const clientDir = path.join(__dirname, "../client");
await app.register(staticFiles, { root: clientDir, prefix: "/", decorateReply: false });

app.setNotFoundHandler(async (req, reply) => {
  if (API_PREFIXES.some(p => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?")) ||
      req.url.startsWith("/health")) {
    return reply.status(404).send({ error: "not found" });
  }
  return reply.sendFile("index.html");
});

// ── Shutdown ───────────────────────────────────────────────────────────────

async function shutdown() {
  await app.close();
  await replication.close();
  await ownStore.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ──────────────────────────────────────────────────────────────────

await connectToPV();
await app.listen({ port: PORT, host: HOST });
app.log.info(`identity: ${pubKeyHex.slice(0, 16)}...`);
app.log.info(`feed: ${ownStore.feedKey.toString("hex").slice(0, 16)}...`);
app.log.info(`PhraseVault: ${PV_URL}`);

// ── Helpers ────────────────────────────────────────────────────────────────

async function ingestFile(filePath: string, opts: { label?: string; mediaNodeId?: string } = {}) {
  const fileBuffer = await import("fs/promises").then(fs => fs.readFile(filePath));
  const hashBytes = createHash("sha256").update(fileBuffer).digest();
  const blake3Hash = Buffer.from(blake3(fileBuffer)).toString("hex");
  const stats = await import("fs/promises").then(fs => fs.stat(filePath));
  const mime = guessMime(filePath);

  const fileNode = await pv.createPvfsFile({
    content_hash: blake3Hash,
    size_bytes: stats.size,
    mime_type: mime,
    original_filename: path.basename(filePath),
    label: opts.label ?? path.basename(filePath),
  }) as { id: string; payload?: Record<string, unknown> };

  await pv.addPvfsLocation(fileNode.id, {
    type: "local",
    uri: `file://${filePath}`,
    label: path.basename(filePath),
  });

  return { fileNode: { ...fileNode, payload: { content_hash: blake3Hash, size_bytes: stats.size, mime_type: mime } } };
}

function guessMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4",
    ".avi": "video/x-msvideo", ".mov": "video/quicktime", ".webm": "video/webm",
    ".ts": "video/mp2t", ".m2ts": "video/mp2t",
  };
  return map[ext] ?? "video/x-matroska";
}

function serializeResult(r: import("../relay/query.js").MediaResult) {
  return {
    id: r.media.id,
    title: r.media.payload.title,
    year: r.media.payload.year,
    kind: r.media.payload.kind,
    genres: r.media.payload.genres,
    imdb_id: r.media.payload.imdb_id,
    sources: r.sources.map(s => ({
      storageNodeId: s.storagePointer.id,
      endpointUrl: s.storagePointer.payload.endpoint_url,
      encoding: s.storagePointer.payload.encoding,
      available: s.storagePointer.payload.available,
      sizeBytes: s.storagePointer.payload.size_bytes,
      feedOwner: s.feedOwner,
    })),
    bestSource: r.bestSource ? {
      endpointUrl: r.bestSource.storagePointer.payload.endpoint_url,
      encoding: r.bestSource.storagePointer.payload.encoding,
    } : null,
    watchlist: r.watchlistEntry ? {
      status: r.watchlistEntry.payload.status,
      addedAt: r.watchlistEntry.payload.added_at,
      progressMs: r.watchlistEntry.payload.progress_ms,
    } : null,
  };
}
