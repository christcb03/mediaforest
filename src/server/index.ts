import Fastify, { FastifyRequest } from "fastify";
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
import argon2 from "argon2";

// ── Config from environment ────────────────────────────────────────────────

const DATA_DIR          = process.env.MF_DATA_DIR          ?? "./data";
const PORT              = parseInt(process.env.MF_PORT     ?? "8080", 10);
const HOST              = process.env.MF_HOST              ?? "0.0.0.0";
const LOG_LEVEL         = process.env.MF_LOG_LEVEL         ?? "info";
const PV_URL            = process.env.MF_PV_URL            ?? "http://localhost:8081";
const MEDIA_DIR         = process.env.MF_MEDIA_DIR         ?? "";
const FORCE_CLOSED_REGISTRATION = process.env.MF_OPEN_REGISTRATION === "false";

// ── Server key + user registry ─────────────────────────────────────────────

interface UserRecord {
  pubKey: string;
  name?: string;
  role: "owner" | "member";
  createdAt: number;
  recoveryPasswordHash?: string;
}

interface ProviderRecord {
  provider_id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface LibraryRecord {
  id: string;
  name: string;
  color?: string;
  defaultPath?: string;
}

interface SectionFilter {
  library?: string;
  genre?: string;
  watchStatus?: string;
  kind?: string;
  available?: boolean;
}

interface SectionRecord {
  id: string;
  name: string;
  view: "row" | "grid";
  filter: SectionFilter;
  sort?: "addedAt" | "year" | "title";
}

interface ServerKey {
  version: number;
  identityPrivKey: string;
  users: UserRecord[];
  authPubKey?: string | null;  // legacy v1 field — migrated on load
  registrationMode?: "open" | "closed";
  providers?: ProviderRecord[];
  libraries?: LibraryRecord[];
  sections?: SectionRecord[];
}

interface InviteToken {
  token: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

const SERVER_KEY_PATH  = path.join(DATA_DIR, "server_key.json");
const INVITES_PATH     = path.join(DATA_DIR, "invites.json");

function loadOrCreateServerKey(): ServerKey {
  let key: ServerKey;
  if (existsSync(SERVER_KEY_PATH)) {
    key = JSON.parse(readFileSync(SERVER_KEY_PATH, "utf-8")) as ServerKey;
  } else {
    mkdirSync(DATA_DIR, { recursive: true });
    key = { version: 2, identityPrivKey: generatePrivKey(), users: [] };
    writeFileSync(SERVER_KEY_PATH, JSON.stringify(key, null, 2), { mode: 0o600 });
    return key;
  }
  // Migrate v1 single-user format
  if (!key.users) {
    key.users = [];
    if (key.authPubKey) {
      key.users.push({ pubKey: key.authPubKey, role: "owner", createdAt: Date.now() });
      delete key.authPubKey;
    }
    key.version = 2;
    saveServerKey(key);
  }
  return key;
}

function saveServerKey(key: ServerKey): void {
  writeFileSync(SERVER_KEY_PATH, JSON.stringify(key, null, 2), { mode: 0o600 });
}

function loadInvites(): InviteToken[] {
  if (!existsSync(INVITES_PATH)) return [];
  try { return JSON.parse(readFileSync(INVITES_PATH, "utf-8")); } catch { return []; }
}

function saveInvites(invites: InviteToken[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(INVITES_PATH, JSON.stringify(invites, null, 2), { mode: 0o600 });
}

const serverKey = loadOrCreateServerKey();

// registrationMode: persisted in server_key.json; defaults to "open" (anyone can register)
// Set MF_OPEN_REGISTRATION=false to force closed regardless of stored setting
let registrationMode: "open" | "closed" = serverKey.registrationMode ?? (FORCE_CLOSED_REGISTRATION ? "closed" : "open");

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

// users map: pubKeyHex → UserRecord
const usersMap = new Map<string, UserRecord>(serverKey.users.map(u => [u.pubKey, u]));

const challenges = new Map<string, number>();
// sessions: token → { userPubKey, expiry }
const sessions   = new Map<string, { userPubKey: string; expiry: number }>();

const PUBLIC_ROUTES = new Set(["/health"]);
const API_PREFIXES = [
  "/search", "/media", "/storage", "/crosslink", "/watchlist",
  "/follow", "/following", "/identity", "/auth", "/tmdb",
  "/pvfs", "/config", "/stream", "/libraries", "/plex",
];
// Auth sub-routes that are public (no Bearer token required)
const PUBLIC_AUTH_PATHS = new Set(["/auth/challenge", "/auth/verify", "/auth/register", "/auth/status", "/auth/login-users", "/auth/recover", "/auth/login-password"]);

// ── Hypercore / relay ──────────────────────────────────────────────────────

const ownStore = new HypercoreStore(path.join(DATA_DIR, "feeds"), pubKeyHex);
await ownStore.open();

const replication = new ReplicationManager(path.join(DATA_DIR, "feeds"));
await replication.shareOwnFeed(ownStore);

const engine = new RelayQueryEngine();
engine.addFeed(pubKeyHex, ownStore);
ownStore._core.on('append', () => { engine.refresh().catch(console.error); });

const FOLLOWED_PATH = path.join(DATA_DIR, "followed.json");
const followedKeys: string[] = existsSync(FOLLOWED_PATH)
  ? JSON.parse(readFileSync(FOLLOWED_PATH, "utf-8"))
  : [];

for (const key of followedKeys) {
  const store = await replication.followFeed(key);
  store._core.on('append', () => { engine.refresh().catch(console.error); });
  engine.addFeed(key, store);
}

await engine.refresh();

// ── Fastify ────────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function issueSession(userPubKey: string): string {
  const now = Date.now();
  // Prune expired
  for (const [tok, s] of sessions) { if (s.expiry < now) sessions.delete(tok); }
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { userPubKey, expiry: now + SESSION_TTL_MS });
  return token;
}

function resolveSession(token: string): UserRecord | null {
  const s = sessions.get(token);
  if (!s || s.expiry < Date.now()) return null;
  return usersMap.get(s.userPubKey) ?? null;
}

const app = Fastify({ logger: { level: LOG_LEVEL } });
await app.register(cors, { origin: true });

// Attach current user to every authenticated request
app.decorateRequest("currentUser", null);

// ── Auth middleware ────────────────────────────────────────────────────────

app.addHook("onRequest", async (req, reply) => {
  const url = req.url.split("?")[0];
  if (PUBLIC_ROUTES.has(url)) return;
  if (PUBLIC_AUTH_PATHS.has(url)) return;
  const isApiRoute = API_PREFIXES.some(p => url === p || url.startsWith(p + "/"));
  if (!isApiRoute) return;
  if (usersMap.size === 0) {
    return reply.status(401).send({ error: "server not configured — register an owner first" });
  }
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "unauthorized" });
  }
  const user = resolveSession(header.slice(7));
  if (!user) {
    return reply.status(401).send({ error: "unauthorized" });
  }
  (req as FastifyRequest & { currentUser: UserRecord }).currentUser = user;
});

// ── Auth endpoints ─────────────────────────────────────────────────────────

app.get("/auth/status", async () => ({
  hasOwner: usersMap.size > 0,
}));

app.get("/auth/login-users", async () => ({
  users: [...usersMap.values()].map(u => ({ name: u.name ?? null, hasPassword: !!u.recoveryPasswordHash })),
}));

app.get("/auth/challenge", async () => ({
  challenge: createChallenge(challenges),
}));

app.post<{ Body: { challenge?: string; signature?: string } }>("/auth/verify", async (req, reply) => {
  const { challenge, signature } = req.body ?? {};
  if (!challenge || !signature) return reply.status(400).send({ error: "missing fields" });
  if (usersMap.size === 0) return reply.status(401).send({ error: "server not configured — register an owner first" });
  if (!consumeChallenge(challenges, challenge)) {
    return reply.status(401).send({ error: "invalid or expired challenge" });
  }
  // Try all registered users
  let matchedUser: UserRecord | null = null;
  for (const user of usersMap.values()) {
    const pubKeyBytes = Buffer.from(user.pubKey, "hex");
    if (verifyAuthSignature(pubKeyBytes, challenge, signature)) {
      matchedUser = user;
      break;
    }
  }
  if (!matchedUser) {
    await new Promise(r => setTimeout(r, 200));
    return reply.status(401).send({ error: "invalid passphrase" });
  }
  return {
    token: issueSession(matchedUser.pubKey),
    identity: pubKeyHex,
    userPubKey: matchedUser.pubKey,
    userRole: matchedUser.role,
    userName: matchedUser.name ?? null,
  };
});

app.post<{ Body: { pubKey?: string; inviteToken?: string; name?: string; recoveryPassword?: string } }>("/auth/register", async (req, reply) => {
  const { pubKey, inviteToken, name, recoveryPassword } = req.body ?? {};
  if (!pubKey || !/^[0-9a-f]{66}$/.test(pubKey)) {
    return reply.status(400).send({ error: "pubKey must be a 33-byte compressed secp256k1 key in hex (66 chars)" });
  }
  if (usersMap.has(pubKey)) return reply.status(409).send({ error: "this key is already registered" });

  let role: "owner" | "member";
  if (usersMap.size === 0) {
    role = "owner";
  } else if (registrationMode === "open") {
    role = "member";
  } else {
    if (!inviteToken) return reply.status(403).send({ error: "invite token required" });
    const invites = loadInvites();
    const invite = invites.find(i => i.token === inviteToken && !i.used && i.expiresAt > Date.now());
    if (!invite) return reply.status(403).send({ error: "invalid or expired invite token" });
    invite.used = true;
    saveInvites(invites);
    role = "member";
  }

  let recoveryPasswordHash: string | undefined;
  if (recoveryPassword && recoveryPassword.length >= 8) {
    recoveryPasswordHash = await argon2.hash(recoveryPassword, { type: argon2.argon2id });
  }

  const user: UserRecord = { pubKey, name: name?.trim() || undefined, role, createdAt: Date.now(), recoveryPasswordHash };
  usersMap.set(pubKey, user);
  serverKey.users = [...usersMap.values()];
  saveServerKey(serverKey);

  return { registered: true, serverIdentity: pubKeyHex, role };
});

app.post<{ Body: { recoveryPassword?: string; newPubKey?: string } }>("/auth/recover", async (req, reply) => {
  const { recoveryPassword, newPubKey } = req.body ?? {};
  if (!recoveryPassword || !newPubKey) {
    return reply.status(400).send({ error: "recoveryPassword and newPubKey required" });
  }
  if (!/^[0-9a-f]{66}$/.test(newPubKey)) {
    return reply.status(400).send({ error: "newPubKey must be a 33-byte compressed secp256k1 key in hex (66 chars)" });
  }

  await new Promise(r => setTimeout(r, 500)); // slow brute-force attempts

  let matchedUser: UserRecord | null = null;
  for (const user of usersMap.values()) {
    if (!user.recoveryPasswordHash) continue;
    try {
      if (await argon2.verify(user.recoveryPasswordHash, recoveryPassword)) {
        matchedUser = user;
        break;
      }
    } catch { continue; }
  }

  if (!matchedUser) {
    return reply.status(401).send({ error: "invalid recovery password" });
  }

  if (usersMap.has(newPubKey) && newPubKey !== matchedUser.pubKey) {
    return reply.status(409).send({ error: "this key is already registered" });
  }

  const oldPubKey = matchedUser.pubKey;
  usersMap.delete(oldPubKey);
  const updatedUser: UserRecord = { ...matchedUser, pubKey: newPubKey };
  usersMap.set(newPubKey, updatedUser);
  serverKey.users = [...usersMap.values()];
  saveServerKey(serverKey);

  return {
    token: issueSession(newPubKey),
    identity: pubKeyHex,
    userPubKey: newPubKey,
    userRole: updatedUser.role,
    userName: updatedUser.name ?? null,
  };
});

// Non-destructive password login: verifies recovery password hash, issues session WITHOUT rotating key
app.post<{ Body: { password?: string; name?: string } }>("/auth/login-password", async (req, reply) => {
  const { password, name } = req.body ?? {};
  if (!password) return reply.status(400).send({ error: "password is required" });
  if (usersMap.size === 0) return reply.status(401).send({ error: "server not configured" });

  // If a name is provided, only check users whose display name matches (case-insensitive).
  // This prevents one user's password from logging in as a different user.
  const candidates = [...usersMap.values()].filter(u => {
    if (!u.recoveryPasswordHash) return false;
    if (name) return (u.name ?? '').toLowerCase() === name.toLowerCase();
    return true;
  });

  let matchedUser: UserRecord | null = null;
  for (const user of candidates) {
    try {
      if (await argon2.verify(user.recoveryPasswordHash!, password)) {
        matchedUser = user;
        break;
      }
    } catch { continue; }
  }

  if (!matchedUser) {
    await new Promise(r => setTimeout(r, 200)); // timing-safe delay
    return reply.status(401).send({ error: "invalid password" });
  }

  return {
    token: issueSession(matchedUser.pubKey),
    identity: pubKeyHex,
    userPubKey: matchedUser.pubKey,
    userRole: matchedUser.role,
    userName: matchedUser.name ?? null,
  };
});

app.post("/auth/invite", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const invites = loadInvites();
  // Prune expired
  const active = invites.filter(i => !i.used && i.expiresAt > Date.now());
  const token = randomBytes(24).toString("hex");
  const invite: InviteToken = {
    token,
    createdBy: user.pubKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    used: false,
  };
  active.push(invite);
  saveInvites(active);
  return { token, expiresAt: invite.expiresAt };
});

app.get("/auth/users", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  return {
    users: [...usersMap.values()].map(u => ({
      pubKey: u.pubKey,
      name: u.name ?? null,
      role: u.role,
      createdAt: u.createdAt,
      hasRecovery: !!u.recoveryPasswordHash,
    })),
  };
});

app.delete<{ Params: { pubKey: string } }>("/auth/users/:pubKey", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const { pubKey } = req.params;
  const target = usersMap.get(pubKey);
  if (!target) return reply.status(404).send({ error: "user not found" });
  if (target.role === "owner") return reply.status(403).send({ error: "cannot remove owner account" });
  usersMap.delete(pubKey);
  serverKey.users = [...usersMap.values()];
  saveServerKey(serverKey);
  for (const [tok, s] of sessions) {
    if (s.userPubKey === pubKey) sessions.delete(tok);
  }
  return { removed: true };
});

app.post<{ Params: { pubKey: string }; Body: { recoveryPassword?: string } }>(
  "/auth/users/:pubKey/reset-recovery",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
    const { pubKey } = req.params;
    const { recoveryPassword } = req.body ?? {};
    const target = usersMap.get(pubKey);
    if (!target) return reply.status(404).send({ error: "user not found" });
    let recoveryPasswordHash: string | undefined;
    if (recoveryPassword && recoveryPassword.length >= 8) {
      recoveryPasswordHash = await argon2.hash(recoveryPassword, { type: argon2.argon2id });
    }
    const updated: UserRecord = { ...target, recoveryPasswordHash };
    usersMap.set(pubKey, updated);
    serverKey.users = [...usersMap.values()];
    saveServerKey(serverKey);
    return { updated: true };
  },
);

app.get("/auth/config", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  return { registrationMode };
});

app.patch<{ Body: { registrationMode?: "open" | "closed" } }>("/auth/config", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const { registrationMode: newMode } = req.body ?? {};
  if (newMode !== "open" && newMode !== "closed") {
    return reply.status(400).send({ error: "registrationMode must be 'open' or 'closed'" });
  }
  registrationMode = newMode;
  serverKey.registrationMode = newMode;
  saveServerKey(serverKey);
  return { registrationMode };
});

// ── Health ─────────────────────────────────────────────────────────────────

app.get("/health", async () => ({
  status: "ok",
  identity: pubKeyHex,
  feedLength: ownStore.length,
  following: followedKeys.length,
  indexed: engine.size,
  pvUrl: PV_URL,
  hasOwner: usersMap.size > 0,
}));

// ── Identity ───────────────────────────────────────────────────────────────

app.get("/identity", async () => ({
  publicKey: pubKeyHex,
  feedKey: ownStore.feedKey.toString("hex"),
}));

// ── Search ─────────────────────────────────────────────────────────────────

app.get<{
  Querystring: { q?: string; kind?: string; available?: string; watchStatus?: string; library?: string; genre?: string }
}>("/search", async (req) => {
  const { q, kind, available, watchStatus, library, genre } = req.query;
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  let results = engine.search({
    query: q,
    kind: kind as never,
    availableOnly: available === "true",
    watchStatus: watchStatus as never,
    currentUserPubKey: currentUser?.pubKey,
  });
  if (library) results = results.filter(r => r.media.payload.library === library);
  if (genre) results = results.filter(r => (r.media.payload.genres as string[] | undefined)?.some(g => g.toLowerCase() === genre.toLowerCase()));
  return { count: results.length, results: results.map(serializeResult) };
});

app.get<{ Params: { id: string } }>("/media/:id", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const result = engine.getById(req.params.id, currentUser?.pubKey);
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
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const node = await createWatchlistEntryNode(privKeyHex, {
    ...req.body,
    user_pub_key: currentUser.pubKey,
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
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const result = engine.getById(req.params.mediaId, currentUser.pubKey);
  if (!result) return reply.status(404).send({ error: "media not found" });
  const existing = result.watchlistEntry;
  const status = (req.body.status ?? existing?.payload.status ?? "unwatched") as import("../relay/types.js").WatchStatus;
  const node = await createWatchlistEntryNode(privKeyHex, {
    media_node_id: req.params.mediaId,
    crosslink_node_id: existing?.payload.crosslink_node_id ?? "",
    user_pub_key: currentUser.pubKey,
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
  store._core.on('append', () => { engine.refresh().catch(console.error); });
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

// ── Config / providers (stored locally in server_key.json) ────────────────

const DEFAULT_PROVIDERS: ProviderRecord[] = [
  { provider_id: "tmdb", name: "TMDB", enabled: false, config: {} },
];

function getProvidersLocal(): ProviderRecord[] {
  if (!serverKey.providers || serverKey.providers.length === 0) {
    return DEFAULT_PROVIDERS.map(p => ({ ...p }));
  }
  // Merge: ensure all known defaults exist
  const map = new Map(serverKey.providers.map(p => [p.provider_id, p]));
  for (const def of DEFAULT_PROVIDERS) {
    if (!map.has(def.provider_id)) map.set(def.provider_id, { ...def });
  }
  return [...map.values()];
}

function saveProviderLocal(providerId: string, body: Record<string, unknown>): ProviderRecord {
  if (!serverKey.providers) serverKey.providers = DEFAULT_PROVIDERS.map(p => ({ ...p }));
  const existing = serverKey.providers.find(p => p.provider_id === providerId);
  // Pull known top-level fields; everything else goes into config
  const { enabled, name, ...configFields } = body;
  if (existing) {
    if (enabled !== undefined) existing.enabled = enabled as boolean;
    if (name) existing.name = name as string;
    Object.assign(existing.config, configFields);
  } else {
    serverKey.providers.push({
      provider_id: providerId,
      name: (name as string) ?? providerId,
      enabled: (enabled as boolean) ?? false,
      config: configFields,
    });
  }
  saveServerKey(serverKey);
  return serverKey.providers.find(p => p.provider_id === providerId)!;
}

app.get("/config/providers", async () => getProvidersLocal());

app.put<{
  Params: { providerId: string };
  Body: Record<string, unknown>;
}>("/config/providers/:providerId", async (req) => {
  const p = saveProviderLocal(req.params.providerId, req.body);
  return { provider_id: p.provider_id, enabled: p.enabled, updated: true };
});

// ── Libraries ─────────────────────────────────────────────────────────────

function getLibraries(): LibraryRecord[] {
  return serverKey.libraries ?? [];
}

function defaultSectionsForLibraries(libs: LibraryRecord[]): SectionRecord[] {
  const sections: SectionRecord[] = [
    { id: "recently-added", name: "Recently Added", view: "row", filter: {}, sort: "addedAt" },
    { id: "continue", name: "Continue Watching", view: "row", filter: { watchStatus: "watching" }, sort: "addedAt" },
  ];
  for (const lib of libs) {
    sections.push({ id: `lib-${lib.id}`, name: lib.name, view: "grid", filter: { library: lib.id }, sort: "title" });
  }
  return sections;
}

app.get("/libraries", async () => ({ libraries: getLibraries() }));

app.post<{ Body: { name?: string; color?: string; defaultPath?: string } }>("/libraries", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const { name, color, defaultPath } = req.body ?? {};
  if (!name?.trim()) return reply.status(400).send({ error: "name is required" });
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if ((serverKey.libraries ?? []).find(l => l.id === id)) {
    return reply.status(409).send({ error: "a library with that name already exists" });
  }
  const lib: LibraryRecord = { id, name: name.trim(), color, defaultPath };
  serverKey.libraries = [...(serverKey.libraries ?? []), lib];
  // Auto-create a section for this library
  if (!serverKey.sections) serverKey.sections = defaultSectionsForLibraries([]);
  if (!serverKey.sections.find(s => s.filter.library === id)) {
    serverKey.sections.push({ id: `lib-${id}`, name: lib.name, view: "grid", filter: { library: id }, sort: "title" });
  }
  saveServerKey(serverKey);
  reply.status(201);
  return lib;
});

app.patch<{ Params: { id: string }; Body: { name?: string; color?: string; defaultPath?: string } }>(
  "/libraries/:id",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
    const lib = (serverKey.libraries ?? []).find(l => l.id === req.params.id);
    if (!lib) return reply.status(404).send({ error: "library not found" });
    if (req.body.name) lib.name = req.body.name.trim();
    if (req.body.color !== undefined) lib.color = req.body.color;
    if (req.body.defaultPath !== undefined) lib.defaultPath = req.body.defaultPath;
    saveServerKey(serverKey);
    return lib;
  },
);

app.delete<{ Params: { id: string } }>("/libraries/:id", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const idx = (serverKey.libraries ?? []).findIndex(l => l.id === req.params.id);
  if (idx === -1) return reply.status(404).send({ error: "library not found" });
  serverKey.libraries!.splice(idx, 1);
  saveServerKey(serverKey);
  return { removed: true };
});

// ── Sections ──────────────────────────────────────────────────────────────

function getSections(): SectionRecord[] {
  if (!serverKey.sections || serverKey.sections.length === 0) {
    return defaultSectionsForLibraries(serverKey.libraries ?? []);
  }
  return serverKey.sections;
}

app.get("/config/sections", async () => ({ sections: getSections() }));

app.post<{ Body: { name?: string; view?: string; filter?: SectionFilter; sort?: string } }>(
  "/config/sections",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
    const { name, view = "grid", filter = {}, sort = "addedAt" } = req.body ?? {};
    if (!name?.trim()) return reply.status(400).send({ error: "name is required" });
    const id = `section-${randomBytes(8).toString("hex")}`;
    const section: SectionRecord = { id, name: name.trim(), view: (view === "row" ? "row" : "grid"), filter, sort: sort as SectionRecord["sort"] };
    serverKey.sections = [...getSections(), section];
    saveServerKey(serverKey);
    reply.status(201);
    return section;
  },
);

app.patch<{ Params: { id: string }; Body: { name?: string; view?: string; filter?: SectionFilter; sort?: string } }>(
  "/config/sections/:id",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
    const sections = getSections();
    const s = sections.find(s => s.id === req.params.id);
    if (!s) return reply.status(404).send({ error: "section not found" });
    if (req.body.name) s.name = req.body.name.trim();
    if (req.body.view) s.view = req.body.view === "row" ? "row" : "grid";
    if (req.body.filter) s.filter = req.body.filter;
    if (req.body.sort) s.sort = req.body.sort as SectionRecord["sort"];
    serverKey.sections = sections;
    saveServerKey(serverKey);
    return s;
  },
);

app.delete<{ Params: { id: string } }>("/config/sections/:id", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const sections = getSections();
  const idx = sections.findIndex(s => s.id === req.params.id);
  if (idx === -1) return reply.status(404).send({ error: "section not found" });
  sections.splice(idx, 1);
  serverKey.sections = sections;
  saveServerKey(serverKey);
  return { removed: true };
});

app.post<{ Body: { ids: string[] } }>("/config/sections/reorder", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (user?.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids)) return reply.status(400).send({ error: "ids array required" });
  const sections = getSections();
  const map = new Map(sections.map(s => [s.id, s]));
  const reordered = ids.map(id => map.get(id)).filter(Boolean) as SectionRecord[];
  // Append any sections not mentioned in ids at the end
  for (const s of sections) { if (!ids.includes(s.id)) reordered.push(s); }
  serverKey.sections = reordered;
  saveServerKey(serverKey);
  return { sections: reordered };
});

// ── Batch import (scan → confirm → import) ────────────────────────────────

type ImportMatchSource =
  | { source: 'tmdb'; tmdb_id: string; media_type: 'movie' | 'tv'; title: string; year: string; poster_path?: string | null }
  | { source: 'manual'; title: string; year: number | null; kind: 'movie' | 'series' };

interface ImportItemBody {
  kind: 'movie' | 'series';
  files: Array<{
    path: string; size_bytes: number; ext: string; already_ingested?: boolean;
    parsed: { title: string; year: number | null; kind: string; season: number | null; episode: number | null };
  }>;
  selected_seasons?: number[] | null;
  match: ImportMatchSource;
  library?: string;
  tags?: string[];
}

app.post<{ Body: { items: ImportItemBody[] } }>("/media/import/batch", async (req, reply) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return reply.status(400).send({ error: "items array is required" });
  }

  const results: Array<{ mediaNodeId: string; title: string; fileCount: number }> = [];
  const failures: Array<{ title: string; error: string }> = [];

  for (const item of items) {
    const itemTitle = item.match.title;
    try {
      let mediaNodeId: string;

      if (item.match.source === "tmdb") {
        const tmdbMatch = item.match;
        // Dedup: reuse existing media node if we already have this tmdb_id
        const existing = engine.search({}).find(r => r.media.payload.tmdb_id === tmdbMatch.tmdb_id);
        if (existing) {
          mediaNodeId = existing.media.id;
        } else {
          // Fetch full TMDB details for metadata enrichment
          let genres: string[] | undefined;
          let imdbId: string | undefined;
          let tvdbId: string | undefined;
          let runtimeMin: number | undefined;
          try {
            const token = getTmdbToken();
            if (token) {
              const segment = tmdbMatch.media_type === "tv" ? "tv" : "movie";
              const res = await fetch(
                `${TMDB_BASE}/${segment}/${tmdbMatch.tmdb_id}?append_to_response=external_ids`,
                { headers: tmdbHeaders(token) },
              );
              const d = await res.json() as Record<string, unknown>;
              genres = ((d.genres as { name: string }[] | undefined) ?? []).map(g => g.name);
              const extIds = (d.external_ids ?? {}) as Record<string, unknown>;
              imdbId  = (d.imdb_id ?? extIds.imdb_id) as string | undefined;
              tvdbId  = extIds.tvdb_id ? String(extIds.tvdb_id) : undefined;
              runtimeMin = tmdbMatch.media_type === "movie"
                ? d.runtime as number | undefined
                : (d.episode_run_time as number[] | undefined)?.[0];
            }
          } catch { /* proceed without enrichment */ }

          const kind = tmdbMatch.media_type === "tv" ? "series" : "movie";
          const node = await createMediaNode(privKeyHex, {
            title: tmdbMatch.title,
            year: parseInt(tmdbMatch.year) || 0,
            kind,
            tmdb_id: tmdbMatch.tmdb_id,
            imdb_id: imdbId,
            tvdb_id: tvdbId,
            genres,
            duration_ms: runtimeMin ? runtimeMin * 60_000 : undefined,
            poster_path: tmdbMatch.poster_path ?? undefined,
            library: item.library,
            tags: item.tags,
          });
          await ownStore.append(node);
          mediaNodeId = node.id;
        }
      } else {
        const kind = item.kind === "series" ? "series" : "movie";
        const node = await createMediaNode(privKeyHex, {
          title: item.match.title,
          year: item.match.year ?? 0,
          kind,
          library: item.library,
          tags: item.tags,
        });
        await ownStore.append(node);
        mediaNodeId = node.id;
      }

      // Ingest files and create storage_pointer nodes
      let fileCount = 0;
      for (const file of item.files) {
        if (file.already_ingested) continue;
        try {
          const { fileNode } = await ingestFile(file.path, {
            label: file.parsed.title || path.basename(file.path),
          });
          const storageNode = await createStoragePointerNode(privKeyHex, {
            media_node_id: mediaNodeId,
            endpoint_url: `/stream/${fileNode.id}`,
            content_hash: fileNode.payload.content_hash as string,
            size_bytes: file.size_bytes,
            encoding: guessEncoding(file.path),
            container: file.ext.replace(".", "") || "mkv",
            available: true,
          });
          await ownStore.append(storageNode);
          fileCount++;
        } catch { /* individual file failure doesn't abort the item */ }
      }

      results.push({ mediaNodeId, title: itemTitle, fileCount });
    } catch (err) {
      failures.push({ title: itemTitle, error: err instanceof Error ? err.message : "import failed" });
    }
  }

  await engine.refresh();
  return reply.send({ imported: results.length, failed: failures.length, results, failures });
});

// ── TMDB proxy (reads token from PV config) ───────────────────────────────

const TMDB_BASE = "https://api.themoviedb.org/3";

function getTmdbToken(): string {
  const providers = getProvidersLocal();
  const tmdb = providers.find(p => p.provider_id === "tmdb");
  return (tmdb?.enabled && tmdb?.config?.read_access_token as string) || "";
}

function tmdbHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

app.get<{ Querystring: { q?: string } }>("/tmdb/search", async (req, reply) => {
  const token = getTmdbToken();
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
  const token = getTmdbToken();
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

// ── Plex integration ──────────────────────────────────────────────────────

import { PlexClient } from "../plex/client.js";

function getPlexClient(): PlexClient | null {
  const providers = getProvidersLocal();
  const plex = providers.find(p => p.provider_id === "plex" && p.enabled);
  if (!plex) return null;
  const url = plex.config.server_url as string;
  const token = plex.config.token as string;
  if (!url || !token) return null;
  return new PlexClient(url, token);
}

app.get("/plex/status", async (_req, reply) => {
  const client = getPlexClient();
  if (!client) return reply.status(503).send({ error: "Plex not configured — add server URL and token in Settings" });
  try {
    const info = await client.ping();
    return { connected: true, version: info.version };
  } catch (err) {
    return reply.status(502).send({ error: err instanceof Error ? err.message : "Could not reach Plex server" });
  }
});

app.get("/plex/libraries", async (_req, reply) => {
  const client = getPlexClient();
  if (!client) return reply.status(503).send({ error: "Plex not configured" });
  try {
    const sections = await client.getSections();
    return { sections };
  } catch (err) {
    return reply.status(502).send({ error: err instanceof Error ? err.message : "Plex error" });
  }
});

app.post<{
  Body: { sectionKey: string; library?: string; syncWatchStatus?: boolean; tags?: string[] };
}>("/plex/import", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const client = getPlexClient();
  if (!client) return reply.status(503).send({ error: "Plex not configured" });

  const { sectionKey, library, syncWatchStatus = true, tags } = req.body ?? {};
  if (!sectionKey) return reply.status(400).send({ error: "sectionKey is required" });

  let items;
  try {
    items = await client.getSectionItems(sectionKey);
  } catch (err) {
    return reply.status(502).send({ error: err instanceof Error ? err.message : "Plex error" });
  }

  const results: Array<{ title: string; mediaNodeId: string; action: string }> = [];
  const failures: Array<{ title: string; error: string }> = [];
  const tmdbToken = getTmdbToken();

  for (const item of items) {
    try {
      // 1. Dedup: find existing media node by tmdb_id or title+year
      let mediaNodeId: string | null = null;
      if (item.tmdbId) {
        const existing = engine.search({}).find(r => r.media.payload.tmdb_id === item.tmdbId);
        if (existing) mediaNodeId = existing.media.id;
      }
      if (!mediaNodeId) {
        const existing = engine.search({}).find(r =>
          r.media.payload.title === item.title && r.media.payload.year === item.year
        );
        if (existing) mediaNodeId = existing.media.id;
      }

      let action = "skipped";

      if (!mediaNodeId) {
        // 2. Enrich from TMDB if we have an ID
        let genres: string[] | undefined;
        let imdbId = item.imdbId;
        let tvdbId = item.tvdbId;
        let posterPath = item.thumb;
        let tmdbPosterPath: string | null | undefined;

        if (item.tmdbId && tmdbToken) {
          try {
            const segment = item.type === "show" ? "tv" : "movie";
            const res = await fetch(
              `${TMDB_BASE}/${segment}/${item.tmdbId}?append_to_response=external_ids`,
              { headers: tmdbHeaders(tmdbToken) },
            );
            const d = await res.json() as Record<string, unknown>;
            genres = ((d.genres as { name: string }[] | undefined) ?? []).map(g => g.name);
            const extIds = (d.external_ids ?? {}) as Record<string, unknown>;
            if (!imdbId) imdbId = (d.imdb_id ?? extIds.imdb_id) as string | undefined;
            if (!tvdbId) tvdbId = extIds.tvdb_id ? String(extIds.tvdb_id) : undefined;
            tmdbPosterPath = d.poster_path as string | null;
          } catch { /* proceed without TMDB enrichment */ }
        }

        const kind = item.type === "show" ? "series" : "movie";
        const mediaNode = await createMediaNode(privKeyHex, {
          title: item.title,
          year: item.year,
          kind,
          tmdb_id: item.tmdbId,
          imdb_id: imdbId,
          tvdb_id: tvdbId,
          genres,
          poster_path: tmdbPosterPath ?? undefined,
          library,
          tags,
        });
        await ownStore.append(mediaNode);
        mediaNodeId = mediaNode.id;
        action = "imported";

        // 3. Create storage pointer for Plex stream URL
        if (item.parts.length > 0) {
          const part = item.parts[0];
          const streamUrl = client.directPlayUrl(part.key);
          const storageNode = await createStoragePointerNode(privKeyHex, {
            media_node_id: mediaNodeId,
            endpoint_url: streamUrl,
            content_hash: `plex:${item.ratingKey}`,
            size_bytes: part.size,
            encoding: "plex",
            container: part.container,
            available: true,
          });
          await ownStore.append(storageNode);
        }
      }

      // 4. Sync watch status
      if (syncWatchStatus && mediaNodeId) {
        const existing = engine.getById(mediaNodeId, currentUser.pubKey);
        let status: import("../relay/types.js").WatchStatus = "unwatched";
        if (item.viewCount > 0) status = "watched";
        else if (item.lastViewedAt) status = "watching";

        const existingEntry = existing?.watchlistEntry;
        if (!existingEntry || existingEntry.payload.status !== status) {
          const wNode = await createWatchlistEntryNode(privKeyHex, {
            media_node_id: mediaNodeId,
            crosslink_node_id: existingEntry?.payload.crosslink_node_id ?? "",
            user_pub_key: currentUser.pubKey,
            status,
            added_at: existingEntry?.payload.added_at ?? (item.addedAt * 1000),
            size_bytes: existingEntry?.payload.size_bytes ?? (item.parts[0]?.size ?? 0),
            ...(status === "watched" && item.lastViewedAt
              ? { watched_at: item.lastViewedAt * 1000 }
              : {}),
          });
          await ownStore.append(wNode);
          if (action === "skipped") action = "watch-synced";
        }
      }

      results.push({ title: item.title, mediaNodeId: mediaNodeId!, action });
    } catch (err) {
      failures.push({ title: item.title, error: err instanceof Error ? err.message : "import failed" });
    }
  }

  await engine.refresh();
  return {
    imported: results.filter(r => r.action === "imported").length,
    watchSynced: results.filter(r => r.action === "watch-synced").length,
    skipped: results.filter(r => r.action === "skipped").length,
    failed: failures.length,
    results,
    failures,
  };
});

app.post("/plex/sync-watch", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const client = getPlexClient();
  if (!client) return reply.status(503).send({ error: "Plex not configured" });

  // Find all storage pointers that look like Plex direct-play URLs
  const allResults = engine.search({ currentUserPubKey: currentUser.pubKey });
  const plexResults = allResults.filter(r =>
    r.sources.some(s => s.storagePointer.payload.endpoint_url.includes("/library/parts/"))
  );

  let updated = 0;
  let skipped = 0;

  for (const result of plexResults) {
    // Extract ratingKey from content_hash (stored as "plex:{ratingKey}")
    const plexSource = result.sources.find(s =>
      (s.storagePointer.payload.content_hash as string).startsWith("plex:")
    );
    if (!plexSource) { skipped++; continue; }

    const ratingKey = (plexSource.storagePointer.payload.content_hash as string).slice(5);

    try {
      // Fetch current item state from Plex
      const data = await fetch(
        `${client.baseUrl}/library/metadata/${ratingKey}?X-Plex-Token=${client.token}`,
        { headers: { Accept: "application/json" } }
      );
      if (!data.ok) { skipped++; continue; }
      const json = await data.json() as { MediaContainer?: { Metadata?: Array<{ viewCount?: number; lastViewedAt?: number }> } };
      const item = json.MediaContainer?.Metadata?.[0];
      if (!item) { skipped++; continue; }

      let status: import("../relay/types.js").WatchStatus = "unwatched";
      if ((item.viewCount ?? 0) > 0) status = "watched";
      else if (item.lastViewedAt) status = "watching";

      const existingEntry = result.watchlistEntry;
      if (existingEntry?.payload.status === status) { skipped++; continue; }

      const wNode = await createWatchlistEntryNode(privKeyHex, {
        media_node_id: result.media.id,
        crosslink_node_id: existingEntry?.payload.crosslink_node_id ?? "",
        user_pub_key: currentUser.pubKey,
        status,
        added_at: existingEntry?.payload.added_at ?? Date.now(),
        size_bytes: existingEntry?.payload.size_bytes ?? 0,
        ...(status === "watched" && item.lastViewedAt
          ? { watched_at: item.lastViewedAt * 1000 }
          : {}),
      });
      await ownStore.append(wNode);
      updated++;
    } catch { skipped++; }
  }

  await engine.refresh();
  return { updated, skipped };
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
    const token = getTmdbToken();
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
  const stats = await import("fs/promises").then(fs => fs.stat(filePath));
  // Stream-hash so large video files don't get loaded into RAM
  const hasher = blake3.create({});
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on('data', (chunk: Buffer | string) => hasher.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    s.on('end', resolve);
    s.on('error', reject);
  });
  const blake3Hash = Buffer.from(hasher.digest()).toString("hex");
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

function guessEncoding(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(name)) return '4K HDR';
  if (/\b1080p\b/.test(name)) return '1080p';
  if (/\b720p\b/.test(name)) return '720p';
  if (/\b480p\b/.test(name)) return '480p';
  return '1080p';
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
    poster_path: r.media.payload.poster_path as string | undefined,
    library: r.media.payload.library as string | undefined,
    tags: r.media.payload.tags as string[] | undefined,
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
