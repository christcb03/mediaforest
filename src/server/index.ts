import Fastify, { FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createReadStream } from "fs";
import * as fsp from 'fs/promises';
import { Readable } from "node:stream";
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
import { scanVideoFilesAsync, findLocalArtwork } from "../scan/scan.js";
import { startScanWatchdog } from "../scan/scan-watchdog.js";
import { appendScanJobLog } from "../scan/scan-job-log.js";
import { scoreCandidates } from "../scan/matcher.js";
import { runBatchImport } from "../import/batch-import.js";
import type { ImportItemBody } from "../import/types.js";
import {
  listStagedImports, getStagedImport, createStagedImport, deleteStagedImport,
  upsertScanStagedBatch, updateStagedBatchItems,
} from "../import/staging.js";
import {
  getScanSession, upsertScanSession, deleteScanSession, sessionPathSet, normalizeScanPath,
} from "../import/scan-session.js";
import type { ScannedFile } from "../scan/scan.js";
import {
  validateFactoryResetBody, buildFactoryResetPreview,
  executeServerFactoryReset, countStaged,
} from "./factory-reset.js";
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

interface UserSettings {
  providers?: ProviderRecord[];
  sections?: SectionRecord[];
}

interface ServerKey {
  version: number;
  identityPrivKey: string;
  users: UserRecord[];
  authPubKey?: string | null;  // legacy v1 field — migrated on load
  registrationMode?: "open" | "closed";
  providers?: ProviderRecord[];   // legacy — migrated to userSettings on load
  sections?: SectionRecord[];     // legacy — migrated to userSettings on load
  libraries?: LibraryRecord[];
  userSettings?: Record<string, UserSettings>;
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
  // Migrate root-level providers/sections to owner's userSettings
  const ownerRecord = key.users.find(u => u.role === "owner");
  if (ownerRecord && (key.providers !== undefined || key.sections !== undefined)) {
    if (!key.userSettings) key.userSettings = {};
    const ownerSettings = key.userSettings[ownerRecord.pubKey] ?? {};
    if (key.providers !== undefined && !ownerSettings.providers) {
      ownerSettings.providers = key.providers;
    }
    if (key.sections !== undefined && !ownerSettings.sections) {
      ownerSettings.sections = key.sections;
    }
    key.userSettings[ownerRecord.pubKey] = ownerSettings;
    delete key.providers;
    delete key.sections;
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
  "/pvfs", "/config", "/stream", "/libraries", "/plex", "/admin",
];
// Auth sub-routes that are public (no Bearer token required)
const PUBLIC_AUTH_PATHS = new Set(["/auth/challenge", "/auth/verify", "/auth/register", "/auth/status", "/auth/login-users", "/auth/recover", "/auth/login-password"]);

// ── Hypercore / relay ──────────────────────────────────────────────────────

let ownStore = new HypercoreStore(path.join(DATA_DIR, "feeds"), pubKeyHex);
await ownStore.open();

let replication = new ReplicationManager(path.join(DATA_DIR, "feeds"));
await replication.shareOwnFeed(ownStore);

let engine = new RelayQueryEngine();
engine.addFeed(pubKeyHex, ownStore);
ownStore._core.on('append', () => { engine.refresh().catch(console.error); });

const FOLLOWED_PATH = path.join(DATA_DIR, "followed.json");
let followedKeys: string[] = existsSync(FOLLOWED_PATH)
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

  // Per-user attachment filter: only titles the user has cross-linked (source_author matches).
  // If the user has no crosslinks recorded yet, fall back to full results so legacy imports
  // (pre-dating crosslink creation on import) continue to appear. Once crosslinks exist for
  // the user, the view becomes their personal library (supporting per-user title edits).
  if (currentUser?.pubKey) {
    const myMedia = new Set<string>();
    const anyClaimed = new Set<string>();
    for await (const node of ownStore.list()) {
      if (node.type !== 'crosslink') continue;
      const p = node.payload as any;
      if (p.media_node_id) anyClaimed.add(p.media_node_id);
      if (p.source_author === currentUser.pubKey && p.media_node_id) {
        myMedia.add(p.media_node_id);
      }
    }
    if (myMedia.size > 0) {
      results = results.filter(r => myMedia.has(r.media.id) || !anyClaimed.has(r.media.id));
    }
    // else: no crosslinks for this user → legacy global view (keeps pre-existing library visible)
  }

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

// ── Config / providers (per-user, stored in serverKey.userSettings) ───────

const DEFAULT_PROVIDERS: ProviderRecord[] = [
  { provider_id: "tmdb", name: "TMDB", enabled: false, config: {} },
];

function getUserSettings(pubKey: string): UserSettings {
  if (!serverKey.userSettings) serverKey.userSettings = {};
  if (!serverKey.userSettings[pubKey]) serverKey.userSettings[pubKey] = {};
  return serverKey.userSettings[pubKey];
}

function getProvidersForUser(pubKey: string): ProviderRecord[] {
  const settings = getUserSettings(pubKey);
  if (!settings.providers || settings.providers.length === 0) {
    return DEFAULT_PROVIDERS.map(p => ({ ...p }));
  }
  const map = new Map(settings.providers.map(p => [p.provider_id, p]));
  for (const def of DEFAULT_PROVIDERS) {
    if (!map.has(def.provider_id)) map.set(def.provider_id, { ...def });
  }
  return [...map.values()];
}

function saveProviderForUser(pubKey: string, providerId: string, body: Record<string, unknown>): ProviderRecord {
  const settings = getUserSettings(pubKey);
  if (!settings.providers) settings.providers = DEFAULT_PROVIDERS.map(p => ({ ...p }));
  const existing = settings.providers.find(p => p.provider_id === providerId);
  const { enabled, name, ...configFields } = body;
  if (existing) {
    if (enabled !== undefined) existing.enabled = enabled as boolean;
    if (name) existing.name = name as string;
    Object.assign(existing.config, configFields);
  } else {
    settings.providers.push({
      provider_id: providerId,
      name: (name as string) ?? providerId,
      enabled: (enabled as boolean) ?? false,
      config: configFields,
    });
  }
  saveServerKey(serverKey);
  return settings.providers.find(p => p.provider_id === providerId)!;
}

app.get("/config/providers", async (req) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  return getProvidersForUser(user.pubKey);
});

app.put<{
  Params: { providerId: string };
  Body: Record<string, unknown>;
}>("/config/providers/:providerId", async (req) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const p = saveProviderForUser(user.pubKey, req.params.providerId, req.body);
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
  // Auto-append a library section to each user who already has a custom sections list.
  // Users still on defaults will pick it up automatically via defaultSectionsForLibraries.
  const newSection: SectionRecord = { id: `lib-${id}`, name: lib.name, view: "grid", filter: { library: id }, sort: "title" };
  for (const u of serverKey.users) {
    const settings = getUserSettings(u.pubKey);
    if (settings.sections && settings.sections.length > 0 && !settings.sections.find(s => s.filter.library === id)) {
      settings.sections.push(newSection);
    }
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

// ── Sections (per-user) ───────────────────────────────────────────────────

function getSectionsForUser(pubKey: string): SectionRecord[] {
  const settings = getUserSettings(pubKey);
  if (!settings.sections || settings.sections.length === 0) {
    return defaultSectionsForLibraries(serverKey.libraries ?? []);
  }
  return settings.sections;
}

function saveSectionsForUser(pubKey: string, sections: SectionRecord[]): void {
  getUserSettings(pubKey).sections = sections;
  saveServerKey(serverKey);
}

app.get("/config/sections", async (req) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  return { sections: getSectionsForUser(user.pubKey) };
});

app.post<{ Body: { name?: string; view?: string; filter?: SectionFilter; sort?: string } }>(
  "/config/sections",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const { name, view = "grid", filter = {}, sort = "addedAt" } = req.body ?? {};
    if (!name?.trim()) return reply.status(400).send({ error: "name is required" });
    const id = `section-${randomBytes(8).toString("hex")}`;
    const section: SectionRecord = { id, name: name.trim(), view: (view === "row" ? "row" : "grid"), filter, sort: sort as SectionRecord["sort"] };
    saveSectionsForUser(user.pubKey, [...getSectionsForUser(user.pubKey), section]);
    reply.status(201);
    return section;
  },
);

app.patch<{ Params: { id: string }; Body: { name?: string; view?: string; filter?: SectionFilter; sort?: string } }>(
  "/config/sections/:id",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const sections = getSectionsForUser(user.pubKey);
    const s = sections.find(s => s.id === req.params.id);
    if (!s) return reply.status(404).send({ error: "section not found" });
    if (req.body.name) s.name = req.body.name.trim();
    if (req.body.view) s.view = req.body.view === "row" ? "row" : "grid";
    if (req.body.filter) s.filter = req.body.filter;
    if (req.body.sort) s.sort = req.body.sort as SectionRecord["sort"];
    saveSectionsForUser(user.pubKey, sections);
    return s;
  },
);

app.delete<{ Params: { id: string } }>("/config/sections/:id", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const sections = getSectionsForUser(user.pubKey);
  const idx = sections.findIndex(s => s.id === req.params.id);
  if (idx === -1) return reply.status(404).send({ error: "section not found" });
  sections.splice(idx, 1);
  saveSectionsForUser(user.pubKey, sections);
  return { removed: true };
});

app.post<{ Body: { ids: string[] } }>("/config/sections/reorder", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids)) return reply.status(400).send({ error: "ids array required" });
  const sections = getSectionsForUser(user.pubKey);
  const map = new Map(sections.map(s => [s.id, s]));
  const reordered = ids.map(id => map.get(id)).filter(Boolean) as SectionRecord[];
  for (const s of sections) { if (!ids.includes(s.id)) reordered.push(s); }
  saveSectionsForUser(user.pubKey, reordered);
  return { sections: reordered };
});

// ── Import staging ───────────────────────────────────────────────────────────

app.get("/import/staged", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const batches = listStagedImports(DATA_DIR).map(b => ({
    id: b.id,
    stagedAt: b.stagedAt,
    stagedBy: b.stagedBy,
    library: b.library,
    itemCount: b.itemCount,
    mine: b.stagedBy === user.pubKey,
    scanPath: b.scanPath,
    status: b.status,
    scanFileCount: b.scanFiles?.length,
  }));
  return reply.send({ batches });
});

app.post<{ Body: { items: ImportItemBody[]; library?: string } }>(
  "/import/stage",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const { items, library } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: "items array is required" });
    }
    const batch = createStagedImport(DATA_DIR, user.pubKey, items, library);
    return reply.status(201).send({
      id: batch.id,
      stagedAt: batch.stagedAt,
      itemCount: batch.itemCount,
      library: batch.library,
    });
  },
);

app.put<{ Body: { path: string; library?: string; items?: ImportItemBody[] } }>(
  "/import/stage/scan",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const { path: scanPath, library, items } = req.body;
    if (!scanPath) return reply.status(400).send({ error: "path is required" });
    const session = getScanSession(DATA_DIR, scanPath);
    if (!session) return reply.status(404).send({ error: "no scan session for this path" });
    const scanFiles = session.files.map(f => ({
      path: f.path,
      size_bytes: f.size_bytes,
      ext: f.ext,
      already_ingested: f.already_ingested,
      parsed: f.parsed,
    }));
    const batch = upsertScanStagedBatch(
      DATA_DIR,
      user.pubKey,
      scanPath,
      library ?? session.library,
      scanFiles,
      items && items.length > 0 ? "ready" : "scan_in_progress",
    );
    if (items && items.length > 0) {
      updateStagedBatchItems(DATA_DIR, batch.id, items);
    }
    return reply.send({ id: batch.id, itemCount: batch.itemCount, scanFileCount: scanFiles.length });
  },
);

app.post<{ Params: { id: string } }>(
  "/import/commit/:id",
  async (req, reply) => {
    const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const batch = getStagedImport(DATA_DIR, req.params.id);
    if (!batch) return reply.status(404).send({ error: "staged batch not found" });
    const result = await runBatchImport(batchImportDeps(), batch.items, user.pubKey);
    if (batch.scanPath) deleteScanSession(DATA_DIR, batch.scanPath);
    deleteStagedImport(DATA_DIR, batch.id);
    return reply.send({ stagedId: batch.id, ...result });
  },
);

app.delete<{ Params: { id: string } }>(
  "/import/staged/:id",
  async (req, reply) => {
    if (!deleteStagedImport(DATA_DIR, req.params.id)) {
      return reply.status(404).send({ error: "staged batch not found" });
    }
    return reply.send({ discarded: true });
  },
);

// ── Batch import (scan → confirm → import) ────────────────────────────────

app.post<{ Body: { items: ImportItemBody[] } }>("/media/import/batch", async (req, reply) => {
  const importUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return reply.status(400).send({ error: "items array is required" });
  }
  const result = await runBatchImport(batchImportDeps(), items, importUser.pubKey);
  return reply.send(result);
});

// ── TMDB proxy (reads token from PV config) ───────────────────────────────

const TMDB_BASE = "https://api.themoviedb.org/3";

function getOwnerPubKey(): string | null {
  return serverKey.users.find(u => u.role === "owner")?.pubKey ?? null;
}

function getTmdbToken(pubKey: string): string {
  const providers = getProvidersForUser(pubKey);
  const tmdb = providers.find(p => p.provider_id === "tmdb");
  return (tmdb?.enabled && tmdb?.config?.read_access_token as string) || "";
}

function tmdbHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

app.get<{ Querystring: { q?: string } }>("/tmdb/search", async (req, reply) => {
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const token = getTmdbToken(user.pubKey);
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
  const user = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  const token = getTmdbToken(user.pubKey);
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
  const ownerKey = getOwnerPubKey();
  const providers = ownerKey ? getProvidersForUser(ownerKey) : [];
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
  const tmdbToken = getTmdbToken(getOwnerPubKey() ?? "");

  // Build dedup indexes once rather than calling engine.search({}) per item
  const existingMedia = engine.search({});
  const byTmdbId = new Map(existingMedia.filter(r => r.media.payload.tmdb_id).map(r => [r.media.payload.tmdb_id, r.media.id]));
  const byTitleYear = new Map(existingMedia.map(r => [`${r.media.payload.title}::${r.media.payload.year}`, r.media.id]));

  // Pre-fetch TMDB enrichment for all new items in parallel batches
  type TmdbEnrichment = { genres?: string[]; imdbId?: string; tvdbId?: string; posterPath?: string | null };
  const tmdbCache = new Map<string, TmdbEnrichment>();
  if (tmdbToken) {
    const TMDB_CONCURRENCY = 8;
    const TMDB_TIMEOUT_MS = 10_000;
    const needsEnrichment = items.filter(item =>
      item.tmdbId &&
      !byTmdbId.has(item.tmdbId) &&
      !byTitleYear.has(`${item.title}::${item.year}`)
    );
    for (let i = 0; i < needsEnrichment.length; i += TMDB_CONCURRENCY) {
      await Promise.all(needsEnrichment.slice(i, i + TMDB_CONCURRENCY).map(async item => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
        try {
          const segment = item.type === "show" ? "tv" : "movie";
          const res = await fetch(
            `${TMDB_BASE}/${segment}/${item.tmdbId}?append_to_response=external_ids`,
            { headers: tmdbHeaders(tmdbToken), signal: controller.signal },
          );
          const d = await res.json() as Record<string, unknown>;
          const extIds = (d.external_ids ?? {}) as Record<string, unknown>;
          tmdbCache.set(item.tmdbId!, {
            genres: ((d.genres as { name: string }[] | undefined) ?? []).map(g => g.name),
            imdbId: (d.imdb_id ?? extIds.imdb_id) as string | undefined,
            tvdbId: extIds.tvdb_id ? String(extIds.tvdb_id) : undefined,
            posterPath: d.poster_path as string | null,
          });
        } catch { /* proceed without TMDB enrichment for this item */ } finally {
          clearTimeout(timer);
        }
      }));
    }
  }

  for (const item of items) {
    try {
      // 1. Dedup: find existing media node by tmdb_id or title+year
      let mediaNodeId: string | null = null;
      if (item.tmdbId) {
        mediaNodeId = byTmdbId.get(item.tmdbId) ?? null;
      }
      if (!mediaNodeId) {
        mediaNodeId = byTitleYear.get(`${item.title}::${item.year}`) ?? null;
      }

      let action = "skipped";

      if (!mediaNodeId) {
        // 2. Use pre-fetched TMDB enrichment if available
        const tmdb = item.tmdbId ? tmdbCache.get(item.tmdbId) : undefined;
        let genres = tmdb?.genres;
        let imdbId = tmdb?.imdbId ?? item.imdbId;
        let tvdbId = tmdb?.tvdbId ?? item.tvdbId;
        let tmdbPosterPath = tmdb?.posterPath;

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
          // Record this user's personal attachment for per-user views/edits
          const clNode = await createCrosslinkNode(privKeyHex, {
            target_node_id: storageNode.id,
            source_author: currentUser.pubKey,
            media_node_id: mediaNodeId,
            added_at: Date.now(),
          });
          await ownStore.append(clNode);
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
  startedAt: number;
  dry_run: boolean;
  scanPath: string;
  library?: string;
  phase?: "indexing" | "walking";
  /** Video files examined on disk. */
  files_seen: number;
  dirs_scanned?: number;
  entries_scanned?: number;
  current_dir?: string;
  /** New files collected this run (not in PhraseVault / prior scan session). */
  found: number;
  new_count?: number;
  already_ingested_count?: number;
  resumed_from_session?: number;
  files: ScannedFile[] | Array<{ path: string; fileNodeId: string; contentHash: string }>;
  ingested?: number;
  failed?: number;
  failures?: Array<{ path: string; error: string }>;
  error?: string;
  index_warning?: string;
  log?: import("../scan/scan-job-log.js").ScanJobLogEntry[];
  last_log?: string;
}
const scanJobs = new Map<string, ScanJob>();

/** Resume only when a recent interrupted scan left partial files on disk. */
const SCAN_SESSION_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function findRunningScanJobForPath(scanPath: string): { jobId: string; job: ScanJob } | null {
  const key = normalizeScanPath(scanPath);
  for (const [jobId, job] of scanJobs) {
    if (job.status === "running" && normalizeScanPath(job.scanPath) === key) {
      return { jobId, job };
    }
  }
  return null;
}

function serializeScanJobPoll(job: ScanJob, since: number) {
  const allFiles = job.files as ScannedFile[];
  return {
    status: job.status,
    startedAt: job.startedAt,
    dry_run: job.dry_run,
    phase: job.phase,
    files_seen: job.files_seen,
    dirs_scanned: job.dirs_scanned,
    entries_scanned: job.entries_scanned,
    current_dir: job.current_dir,
    found: job.found,
    new_count: job.new_count,
    already_ingested_count: job.already_ingested_count,
    resumed_from_session: job.resumed_from_session,
    files_total: allFiles.length,
    files: allFiles.slice(since),
    ingested: job.ingested,
    failed: job.failed,
    failures: job.failures,
    error: job.error,
    index_warning: job.index_warning,
    log: job.log?.slice(-30) ?? [],
    last_log: job.last_log,
  };
}

function persistScanProgress(job: ScanJob, stagedBy: string): void {
  const files = job.files as ScannedFile[];
  setImmediate(() => {
    try {
      upsertScanSession(DATA_DIR, job.scanPath, {
        library: job.library,
        status: job.status === "done" ? "complete" : "scanning",
        files,
      });
      upsertScanStagedBatch(
        DATA_DIR,
        stagedBy,
        job.scanPath,
        job.library,
        files,
        job.status === "done" ? "ready" : "scan_in_progress",
      );
    } catch (err) {
      console.error("persistScanProgress failed", err);
    }
  });
}

app.get<{ Querystring: { path?: string } }>("/pvfs/scan/session", async (req, reply) => {
  const scanPath = req.query.path;
  if (!scanPath) return reply.status(400).send({ error: "path query is required" });
  const session = getScanSession(DATA_DIR, scanPath);
  return reply.send({ session });
});

app.post<{ Body: { path: string; dry_run?: boolean; extensions?: string[]; limit?: number; library?: string } }>(
  "/pvfs/scan",
  async (req, reply) => {
    const scanUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const { path: dirPath, dry_run = true, extensions, limit, library } = req.body;
    if (!dirPath) return reply.status(400).send({ error: "path is required" });

    const running = findRunningScanJobForPath(dirPath);
    if (running) {
      return reply.status(202).send({
        jobId: running.jobId,
        resumed: running.job.resumed_from_session ?? running.job.files.length,
      });
    }

    const priorSession = getScanSession(DATA_DIR, dirPath);
    const resume = priorSession?.status === "scanning"
      && priorSession.files.length > 0
      && Date.now() - priorSession.updatedAt < SCAN_SESSION_RESUME_MAX_AGE_MS;
    const initialFiles = resume ? [...priorSession.files] : [];
    if (!resume) {
      upsertScanSession(DATA_DIR, dirPath, { library, status: "scanning", files: [] });
    }

    const jobId = randomBytes(16).toString("hex");
    const job: ScanJob = {
      status: "running",
      startedAt: Date.now(),
      dry_run,
      scanPath: dirPath,
      library,
      files_seen: 0,
      found: initialFiles.length,
      new_count: initialFiles.length,
      already_ingested_count: 0,
      resumed_from_session: initialFiles.length,
      files: initialFiles,
    };
    scanJobs.set(jobId, job);

    const extSet = extensions
      ? new Set(extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()))
      : undefined;

    const maxNew = limit && limit > 0 ? limit : undefined;
    const scanLog = req.log.child({ jobId, scanPath: dirPath });
    appendScanJobLog(job, "scan accepted", { limit: maxNew, resume: initialFiles.length, dry_run });
    scanLog.info({ limit: maxNew, resume: initialFiles.length }, "scan job accepted");
    let lastPersist = 0;
    let lastProgressLog = 0;

    const watchdog = startScanWatchdog(job, (msg) => {
      job.error = msg;
      job.status = "error";
      appendScanJobLog(job, "scan aborted", { reason: msg });
      scanLog.warn({ reason: msg }, "scan job aborted");
    });

    ;(async () => {
      try {
        appendScanJobLog(job, "filesystem walk starting");
        scanLog.info("filesystem walk starting");

        // Load PV dedup index in parallel — never block the filesystem walk on it.
        let ingestedUris = new Set<string>();
        void pv.getIngestedUriSet(8_000).then((s) => {
          ingestedUris = s;
          appendScanJobLog(job, "phrasevault dedup index loaded", { uris: s.size });
          scanLog.info({ uris: s.size }, "phrasevault dedup index loaded");
        }).catch((err) => {
          appendScanJobLog(job, "phrasevault dedup index skipped", {
            error: err instanceof Error ? err.message : String(err),
          });
          scanLog.warn({ err }, "phrasevault dedup index skipped");
        });

        if (watchdog.isAborted()) return;

        const sessionSkip = sessionPathSet(
          resume ? priorSession : getScanSession(DATA_DIR, dirPath),
        );

        if (dry_run) {
          let newCount = initialFiles.length;
          job.phase = "walking";
          watchdog.touch();
          job.current_dir = dirPath;
          appendScanJobLog(job, `reading ${dirPath}`);
          await scanVideoFilesAsync(dirPath, extSet, (p) => {
            watchdog.touch();
            job.files_seen = p.videoFilesSeen;
            job.dirs_scanned = p.dirsScanned;
            job.entries_scanned = p.entriesScanned;
            job.current_dir = p.currentDir;
            const now = Date.now();
            if (now - lastProgressLog > 5000) {
              lastProgressLog = now;
              const msg = `${p.dirsScanned} folders, ${p.videoFilesSeen} videos, ${newCount} new`;
              appendScanJobLog(job, msg, { dir: p.currentDir });
              scanLog.info({ ...p, newCount }, "scan progress");
            }
          }, (file) => {
            if (watchdog.isAborted()) return false;
            file.already_ingested = ingestedUris.has(`file://${file.path}`);
            if (file.already_ingested) {
              job.already_ingested_count = (job.already_ingested_count ?? 0) + 1;
              return;
            }
            if (sessionSkip.has(file.path)) return;
            if (maxNew && newCount >= maxNew) {
              appendScanJobLog(job, `reached max new files (${maxNew})`);
              scanLog.info({ maxNew }, "scan reached max new files");
              return false;
            }
            (job.files as ScannedFile[]).push(file);
            sessionSkip.add(file.path);
            newCount++;
            job.found = newCount;
            job.new_count = newCount;
            const now = Date.now();
            if (now - lastPersist > 10_000) {
              lastPersist = now;
              persistScanProgress(job, scanUser.pubKey);
            }
          }, {
            skipArtwork: true,
            shouldAbort: () => (watchdog.isAborted() ? job.error ?? "scan aborted" : null),
            onEnterDir: (readDir, attempt) => {
              watchdog.touch();
              job.current_dir = readDir;
              const msg = attempt > 1 ? `retry reading ${readDir} (${attempt})` : `reading ${readDir}`;
              appendScanJobLog(job, msg);
              scanLog.info({ dir: readDir, attempt }, "scan reading directory");
            },
          });
          if (!watchdog.isAborted()) {
            job.status = "done";
            job.phase = undefined;
            appendScanJobLog(job, "scan finished", {
              new_count: job.new_count,
              files_seen: job.files_seen,
              dirs: job.dirs_scanned,
            });
            scanLog.info(
              { new_count: job.new_count, files_seen: job.files_seen },
              "scan job finished",
            );
            persistScanProgress(job, scanUser.pubKey);
          }
          return;
        }

        job.phase = "walking";
        const files = await scanVideoFilesAsync(dirPath, extSet, p => {
          job.files_seen = p.videoFilesSeen;
          job.dirs_scanned = p.dirsScanned;
          job.current_dir = p.currentDir;
        }, undefined, { skipArtwork: true });
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
        if (job.status !== "error") {
          const message = err instanceof Error ? err.message : "scan failed";
          job.error = message;
          job.status = "error";
          appendScanJobLog(job, "scan error", { error: message });
          scanLog.error({ err }, "scan job error");
        }
      } finally {
        watchdog.stop();
      }
    })();

    return reply.status(202).send({ jobId, resumed: initialFiles.length });
  },
);

app.get<{ Params: { jobId: string }; Querystring: { since?: string } }>(
  "/pvfs/scan/job/:jobId",
  async (req, reply) => {
    const job = scanJobs.get(req.params.jobId);
    if (!job) return reply.status(404).send({ error: "job not found (server may have restarted)" });
    const since = Math.max(0, parseInt(req.query.since ?? "0", 10) || 0);
    return reply.send(serializeScanJobPoll(job, since));
  },
);

/** Fast path check — exists only (no directory listing; avoids proxy timeouts). */
app.get<{ Querystring: { path?: string } }>("/pvfs/scan/diagnose", async (req, reply) => {
  const dirPath = req.query.path;
  if (!dirPath) return reply.status(400).send({ error: "path query is required" });
  const exists = existsSync(dirPath);
  req.log.info({ path: dirPath, exists }, "scan diagnose");
  return reply.send({ exists, path: dirPath });
});

// ── PVFS unimported files ─────────────────────────────────────────────────
// Returns PVFS file nodes that have no storage_pointer in the MediaForest feed.
// Used by the Add Media modal to surface local files that are ready to import.

import { parseMediaPath } from "../scan/scan.js";

app.get("/pvfs/unimported", async (_req, reply) => {
  // Collect all stream URLs already referenced by storage_pointer nodes
  const allResults = engine.search({});
  const importedStreamUrls = new Set<string>();
  for (const r of allResults) {
    for (const s of r.sources) {
      importedStreamUrls.add(s.storagePointer.payload.endpoint_url as string);
    }
  }

  // Get all file nodes from PhraseVault
  let pvNodes: Array<{ id: string; payload: { label?: string; original_filename?: string; size_bytes?: number; mime_type?: string } }> = [];
  try {
    const resp = await pv.get<{ nodes: typeof pvNodes }>("/pvfs/locations");
    pvNodes = resp.nodes ?? [];
  } catch {
    return reply.send({ files: [] });
  }

  // Filter to files not yet imported into MediaForest
  const unimported = pvNodes
    .filter(n => !importedStreamUrls.has(`/stream/${n.id}`))
    .map(n => {
      const filename = n.payload.original_filename ?? n.payload.label ?? "";
      const parsed = filename ? parseMediaPath(filename) : { title: filename, year: null, kind: "unknown" as const, season: null, episode: null };
      return {
        fileNodeId: n.id,
        filename,
        size_bytes: n.payload.size_bytes ?? 0,
        streamUrl: `/stream/${n.id}`,
        parsed,
      };
    })
    .filter(f => f.filename); // skip nodes with no usable name

  return reply.send({ files: unimported });
});

// ── Media match (TMDB + confidence scoring) ───────────────────────────────

app.post<{
  Body: {
    items: Array<{
      title: string;
      year: number | null;
      kind: "movie" | "series" | "unknown";
      sample_path?: string;
    }>;
    threshold?: number;
  };
}>(
  "/media/match/search",
  async (req, reply) => {
    const matchUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
    const token = getTmdbToken(matchUser.pubKey);
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
        const scored = scoreCandidates(item, raw, threshold);
        let local_artwork_path: string | null = null;
        if (item.sample_path && (!scored.best || scored.needs_review)) {
          local_artwork_path = findLocalArtwork(item.sample_path, item.title);
        }
        results.push({ ...scored, local_artwork_path });
      } catch {
        let local_artwork_path: string | null = null;
        if (item.sample_path) {
          local_artwork_path = findLocalArtwork(item.sample_path, item.title);
        }
        results.push({
          query: item,
          candidates: [],
          best: null,
          needs_review: true,
          local_artwork_path,
        });
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
  const rangeHeader = req.headers["range"] as string | undefined;
  try {
    const res = await pv.fetchPvfsStream(req.params.nodeId, rangeHeader);
    if (!res.ok) {
      const text = await res.text();
      return reply.status(res.status).send({ error: text || "stream failed" });
    }
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"] as const) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    reply.status(res.status);
    if (!res.body) return reply.send();
    return reply.send(Readable.fromWeb(res.body));
  } catch (err) {
    req.log.warn({ err, nodeId: req.params.nodeId }, "PVFS stream proxy failed");
    return reply.status(502).send({ error: "stream unavailable" });
  }
});

// ── Admin / forest inspector ──────────────────────────────────────────────

app.get("/admin/factory-reset/preview", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (currentUser.role !== "owner") return reply.status(403).send({ error: "owner only" });
  const invites = loadInvites();
  return reply.send(buildFactoryResetPreview({
    engineSize: engine.size,
    users: [...usersMap.values()],
    inviteCount: invites.filter(i => !i.used).length,
    stagedCount: countStaged(DATA_DIR),
    followedCount: followedKeys.length,
    libraryCount: (serverKey.libraries ?? []).length,
  }));
});

app.post<{
  Body: {
    confirmation_phrase?: string;
    acknowledge_irreversible?: boolean;
    acknowledge_remove_all_members?: boolean;
    acknowledge_remove_pvfs_inventory?: boolean;
  };
}>("/admin/factory-reset", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (currentUser.role !== "owner") return reply.status(403).send({ error: "owner only" });

  const body = req.body ?? {};
  const validationErr = validateFactoryResetBody({
    confirmation_phrase: body.confirmation_phrase ?? "",
    acknowledge_irreversible: body.acknowledge_irreversible === true,
    acknowledge_remove_all_members: body.acknowledge_remove_all_members === true,
    acknowledge_remove_pvfs_inventory: body.acknowledge_remove_pvfs_inventory === true,
  });
  if (validationErr) return reply.status(400).send({ error: validationErr });

  try {
    const result = await executeServerFactoryReset({
      dataDir: DATA_DIR,
      pubKeyHex,
      catalog: { ownStore, engine, replication },
      pv,
      body: {
        confirmation_phrase: body.confirmation_phrase!,
        acknowledge_irreversible: true,
        acknowledge_remove_all_members: true,
        acknowledge_remove_pvfs_inventory: true,
      },
      getUsers: () => [...usersMap.values()],
      setUsers: (users) => {
        usersMap.clear();
        for (const u of users) usersMap.set(u.pubKey, u as UserRecord);
        serverKey.users = users as UserRecord[];
        saveServerKey(serverKey);
      },
      getOwnerPubKey,
      clearInvites: () => {
        const n = loadInvites().length;
        saveInvites([]);
        return n;
      },
      clearFollowed: async () => {
        const n = followedKeys.length;
        followedKeys = [];
        writeFileSync(FOLLOWED_PATH, "[]", { mode: 0o600 });
        return n;
      },
      clearServerSettings: (ownerPub) => {
        serverKey.userSettings = { [ownerPub]: {} };
        serverKey.libraries = [];
        saveServerKey(serverKey);
      },
      clearSessions: () => { sessions.clear(); },
    });
    ownStore = result.catalog.ownStore;
    engine = result.catalog.engine;
    replication = result.catalog.replication;
    return reply.send({ ok: result.ok, summary: result.summary });
  } catch (err) {
    req.log.error({ err }, "factory reset failed");
    const message = err instanceof Error ? err.message : "factory reset failed";
    return reply.status(500).send({ error: message, message });
  }
});

app.get("/admin/stats", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (currentUser.role !== "owner") return reply.status(403).send({ error: "owner only" });

  const counts: Record<string, number> = { media: 0, storage_pointer: 0, crosslink: 0, watchlist_entry: 0, unknown: 0 };
  for await (const node of ownStore.list()) {
    const t = node.type;
    if (t in counts) counts[t]++;
    else counts.unknown++;
  }

  return {
    feedKey: ownStore.feedKey.toString("hex"),
    storeBlocks: ownStore.length,
    byType: counts,
    engineIndexed: engine.size,
  };
});

app.get<{
  Querystring: { type?: string; q?: string; offset?: string; limit?: string };
}>("/admin/nodes", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (currentUser.role !== "owner") return reply.status(403).send({ error: "owner only" });

  const { type, q, offset: offsetStr = "0", limit: limitStr = "50" } = req.query;
  const offset = Math.max(0, parseInt(offsetStr, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(limitStr, 10) || 50));

  const all = [];
  for await (const node of ownStore.list()) {
    if (type && node.type !== type) continue;
    if (q) {
      const haystack = (JSON.stringify(node.payload) + " " + node.id).toLowerCase();
      if (!haystack.includes(q.toLowerCase())) continue;
    }
    all.push(node);
  }

  return {
    total: all.length,
    offset,
    limit,
    nodes: all.slice(offset, offset + limit),
  };
});

// ── Admin: replace/update a media title's metadata (creates new node + migrates sources/watchlists) ──
app.post<{ Body: { old_media_id: string; payload: MediaPayload } }>("/admin/media/replace", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;

  const { old_media_id, payload } = req.body;
  if (!old_media_id || !payload || !payload.title) {
    return reply.status(400).send({ error: "old_media_id and payload with title required" });
  }

  // 1. Create the updated media node (new id because content-addressed)
  const newMedia = await createMediaNode(privKeyHex, payload);
  await ownStore.append(newMedia);

  // 2. Per-user migration: only migrate the *current user's* crosslinks, their linked storage_pointers, and their watchlist_entries.
  // This keeps each user's view of the title separate.
  const storageMap = new Map<string, string>(); // old storage id -> new storage id
  const crosslinkMap = new Map<string, string>(); // old cl id -> new cl id

  let migratedStorages = 0;
  let migratedCrosslinks = 0;
  let migratedWatchlists = 0;

  // First, identify the user's crosslinks for this media (these define "my" attachments)
  const myCrosslinkTargets = new Set<string>(); // storage ids the user has crosslinked for this media
  for await (const node of ownStore.list()) {
    if (node.type !== "crosslink") continue;
    const p = node.payload as any;
    if (p.media_node_id === old_media_id && p.source_author === currentUser.pubKey) {
      myCrosslinkTargets.add(p.target_node_id);
    }
  }

  // Migrate the user's storage pointers (only those linked by the user's crosslinks for this media).
  // On first edit/claim for a legacy title (no prior crosslinks for this user on the media), claim
  // the storages so the edited version becomes the user's personal copy.
  for await (const node of ownStore.list()) {
    if (node.type !== "storage_pointer") continue;
    const p = node.payload as any;
    if (p.media_node_id !== old_media_id) continue;
    if (myCrosslinkTargets.size > 0 && !myCrosslinkTargets.has(node.id)) continue; // only user's (or all if first claim)

    const newSPPayload: StoragePointerPayload = {
      ...p,
      media_node_id: newMedia.id,
    };
    const newSP = await createStoragePointerNode(privKeyHex, newSPPayload);
    await ownStore.append(newSP);
    storageMap.set(node.id, newSP.id);
    migratedStorages++;
  }

  // Migrate the user's crosslinks (re-point to new storage + new media)
  for await (const node of ownStore.list()) {
    if (node.type !== "crosslink") continue;
    const p = node.payload as any;
    if (p.media_node_id !== old_media_id || p.source_author !== currentUser.pubKey) continue;

    const newTarget = storageMap.get(p.target_node_id) || p.target_node_id;
    const newCLPayload: CrosslinkPayload = {
      ...p,
      target_node_id: newTarget,
      media_node_id: newMedia.id,
      added_at: p.added_at ?? Date.now(),
    };
    const newCL = await createCrosslinkNode(privKeyHex, newCLPayload);
    await ownStore.append(newCL);
    crosslinkMap.set(node.id, newCL.id);
    migratedCrosslinks++;
  }

  // If this was the first time the user claimed/attached this media (no prior crosslink for them),
  // create the crosslink(s) now for the storage(s) we just claimed under the new media node.
  // This ensures the title enters their per-user view and future edits migrate cleanly.
  if (migratedStorages > 0 && migratedCrosslinks === 0) {
    for (const [, newStorageId] of storageMap) {
      const newCLPayload: CrosslinkPayload = {
        target_node_id: newStorageId,
        source_author: currentUser.pubKey,
        media_node_id: newMedia.id,
        added_at: Date.now(),
      };
      const newCL = await createCrosslinkNode(privKeyHex, newCLPayload);
      await ownStore.append(newCL);
      migratedCrosslinks++;
    }
  }

  // Migrate the user's watchlist entries
  for await (const node of ownStore.list()) {
    if (node.type !== "watchlist_entry") continue;
    const p = node.payload as any;
    if (p.media_node_id !== old_media_id || p.user_pub_key !== currentUser.pubKey) continue;

    const newCLid = crosslinkMap.get(p.crosslink_node_id) || p.crosslink_node_id;
    const newWLPayload: WatchlistEntryPayload = {
      ...p,
      media_node_id: newMedia.id,
      crosslink_node_id: newCLid,
      added_at: p.added_at ?? Date.now(),
    };
    const newWL = await createWatchlistEntryNode(privKeyHex, newWLPayload);
    await ownStore.append(newWL);
    migratedWatchlists++;
  }

  await engine.refresh();

  return {
    old_media_id,
    new_media_id: newMedia.id,
    migrated_storages: migratedStorages,
    migrated_crosslinks: migratedCrosslinks,
    migrated_watchlists: migratedWatchlists,
  };
});

// ── Admin: delete files/folders from locally mounted media (owner only; local FS only) ──
// Remote/PVFS storage deletes are explicitly not supported.
app.post<{ Body: { path: string } }>("/admin/local-storage/delete", async (req, reply) => {
  const currentUser = (req as FastifyRequest & { currentUser: UserRecord }).currentUser;
  if (currentUser.role !== "owner") return reply.status(403).send({ error: "owner only" });

  const relPath = (req.body.path || "").trim();
  if (!relPath) return reply.status(400).send({ error: "path is required" });

  if (!MEDIA_DIR) {
    return reply.status(400).send({ error: "MF_MEDIA_DIR not configured; local deletes not available" });
  }

  const root = path.resolve(MEDIA_DIR);
  // Normalize and prevent path traversal
  const target = path.resolve(root, relPath.replace(/^\/+/, ""));
  if (!target.startsWith(root + path.sep) && target !== root) {
    return reply.status(403).send({ error: "path is outside the configured media directory" });
  }
  if (target === root) {
    return reply.status(403).send({ error: "refusing to delete the entire media root" });
  }

  try {
    const st = await fsp.stat(target);
    const isDir = st.isDirectory();

    await fsp.rm(target, { recursive: isDir, force: true });

    return { deleted: target.replace(root, ""), wasDirectory: isDir };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return reply.status(404).send({ error: "path not found" });
    }
    if (err.code === "EACCES" || err.code === "EROFS") {
      return reply.status(403).send({ error: "permission denied (mount may be read-only; see docs for enabling deletes on local media)" });
    }
    return reply.status(500).send({ error: "delete failed: " + (err.message || err) });
  }
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

function batchImportDeps() {
  return {
    engine,
    ownStore,
    privKeyHex,
    ingestFile,
    getTmdbToken,
    tmdbHeaders,
    guessEncoding,
  };
}

async function ingestFile(filePath: string, opts: { label?: string; mediaNodeId?: string } = {}) {
  const stats = await import("fs/promises").then(fs => fs.stat(filePath));
  const mime = guessMime(filePath);
  const label = opts.label ?? path.basename(filePath);

  const ingested = await pv.ingestPvfsFile(filePath, {
    label,
    mime_type: mime,
    media_node_id: opts.mediaNodeId,
  });

  return {
    fileNode: {
      id: ingested.fileNodeId,
      payload: {
        content_hash: ingested.contentHash,
        size_bytes: stats.size,
        mime_type: mime,
      },
    },
  };
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
