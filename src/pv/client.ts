/**
 * PhraseVault HTTP client — used by MediaForest server to store/retrieve
 * forest nodes on the PhraseVault platform server.
 *
 * Auth: MF server authenticates to PV using its own secp256k1 keypair.
 * On startup, registers authPubKey with PV (idempotent), then runs
 * challenge/verify to get a session token. Refreshes automatically on 401.
 */

import * as secp from "@noble/secp256k1";
import { blake3 } from "@noble/hashes/blake3";
import { identityFromPrivKey } from "../identity/index.js";

const DOMAIN_CHALLENGE = new TextEncoder().encode("phrasevault:auth-challenge:v1:");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

function hashChallenge(nonce: string): Uint8Array {
  return blake3(concat(DOMAIN_CHALLENGE, new TextEncoder().encode(nonce)));
}

export interface PvfsIngestResult {
  fileNodeId: string;
  contentHash: string;
  streamUrl: string;
}

export interface PvfsFileResponse {
  node: {
    id: string;
    label: string;
    payload: {
      content_hash: string;
      size_bytes: number;
      mime_type: string;
      original_filename: string | null;
    };
  };
  locations: Array<{ payload: { uri: string; type: string } }>;
  stream_url: string;
}

export interface PvfsScanJobResponse {
  id: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  dry_run: boolean;
  root_path: string;
  found: number;
  new_count?: number;
  already_ingested_count?: number;
  ingested?: number;
  failed?: number;
  files: unknown[];
  failures?: Array<{ path: string; error: string }>;
  error?: string;
}

export class PhraseVaultClient {
  private baseUrl: string;
  private privKeyHex: string;
  private authPubKeyHex: string;
  private token: string | null = null;

  constructor(baseUrl: string, privKeyHex: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.privKeyHex = privKeyHex;
    const identity = identityFromPrivKey(privKeyHex);
    this.authPubKeyHex = Buffer.from(identity.publicKey).toString("hex");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Register this server's auth pubkey with PV (idempotent). */
  async register(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubKey: this.authPubKeyHex }),
    });
    // 409 = already registered with a different key; anything else is fine
    if (!res.ok && res.status !== 409) {
      const body = await res.text();
      throw new Error(`PV register failed ${res.status}: ${body}`);
    }
  }

  /** Authenticate to PV and store session token. */
  async authenticate(): Promise<void> {
    // 1. Get challenge
    const cr = await fetch(`${this.baseUrl}/auth/challenge`);
    if (!cr.ok) throw new Error(`PV challenge failed ${cr.status}`);
    const { challenge } = await cr.json() as { challenge: string };

    // 2. Sign it
    const msgHash = hashChallenge(challenge);
    const sig = await secp.signAsync(msgHash, this.privKeyHex);
    const signatureHex = Buffer.from(sig.toCompactRawBytes()).toString("hex");

    // 3. Verify → session token
    const vr = await fetch(`${this.baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, signature: signatureHex }),
    });
    if (!vr.ok) {
      const body = await vr.text();
      throw new Error(`PV auth failed ${vr.status}: ${body}`);
    }
    const { token } = await vr.json() as { token: string };
    this.token = token;
  }

  /** Ensure we have a valid token, re-authing if needed. */
  private async ensureAuth(): Promise<string> {
    if (!this.token) await this.authenticate();
    return this.token!;
  }

  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.ensureAuth();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: await this.authHeaders(
        body !== undefined ? { "Content-Type": "application/json" } : {},
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.token = null;
      return this.request<T>(method, path, body);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PV ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  get<T>(path: string) { return this.request<T>("GET", path); }
  post<T>(path: string, body?: unknown) { return this.request<T>("POST", path, body); }
  put<T>(path: string, body?: unknown) { return this.request<T>("PUT", path, body); }
  delete<T>(path: string, body?: unknown) { return this.request<T>("DELETE", path, body); }

  /** Stream bytes from PVFS (for proxying to browsers). */
  async fetchPvfsStream(nodeId: string, rangeHeader?: string): Promise<Response> {
    const headers = await this.authHeaders();
    if (rangeHeader) headers.Range = rangeHeader;
    const res = await fetch(`${this.baseUrl}/pvfs/file/${nodeId}/stream`, { headers });
    if (res.status === 401) {
      this.token = null;
      return this.fetchPvfsStream(nodeId, rangeHeader);
    }
    return res;
  }

  // ── Forest helpers ─────────────────────────────────────────────────────────

  async getForestRoots() {
    return this.get<unknown[]>("/forest/roots");
  }

  async walkForest(nodeId: string, depth?: number) {
    const q = depth !== undefined ? `?depth=${depth}` : "";
    return this.get<unknown>(`/forest/walk/${nodeId}${q}`);
  }

  async getNode(nodeId: string) {
    return this.get<unknown>(`/forest/node/${nodeId}`);
  }

  async createNode(input: {
    type: string; label: string; visibility?: string;
    payload: unknown; created_at?: number;
  }) {
    return this.post<unknown>("/forest/node", input);
  }

  async createLink(input: {
    parent_id: string | null; child_id: string; link_type: string;
    truth_score?: number; sort_key?: string | null;
    score_method?: string | null; created_at?: number;
  }) {
    return this.post<unknown>("/forest/link", input);
  }

  async deleteLink(linkId: string) {
    return this.delete<unknown>(`/forest/link/${linkId}`);
  }

  // ── Config helpers ─────────────────────────────────────────────────────────

  async getConfig() {
    return this.get<unknown>("/config");
  }

  async setConfig(section: string, key: string, value: unknown) {
    return this.put<unknown>(`/config/${section}/${key}`, { value });
  }

  async getProviders() {
    return this.get<unknown[]>("/config/providers");
  }

  async upsertProvider(providerId: string, data: Record<string, unknown>) {
    return this.put<unknown>(`/config/providers/${providerId}`, data);
  }

  async getTmdbToken(): Promise<string> {
    try {
      const providers = await this.getProviders() as Array<{ provider_id: string; config: Record<string, unknown> }>;
      const tmdb = providers.find(p => p.provider_id === "tmdb");
      return (tmdb?.config["read_access_token"] as string | undefined) ?? "";
    } catch {
      return "";
    }
  }

  // ── PVFS helpers ───────────────────────────────────────────────────────────

  async getPvfsFile(nodeId: string) {
    return this.get<PvfsFileResponse>(`/pvfs/file/${nodeId}`);
  }

  /** Register a file on the PV host filesystem (path must exist inside PV container). */
  async ingestPvfsFile(pathOnPvHost: string, opts: {
    label?: string;
    mime_type?: string;
    media_node_id?: string;
    compute_hash?: boolean;
  } = {}): Promise<PvfsIngestResult> {
    return this.post<PvfsIngestResult>("/pvfs/ingest", {
      path: pathOnPvHost,
      label: opts.label,
      mime_type: opts.mime_type,
      media_node_id: opts.media_node_id,
    });
  }

  async locationByUri(uri: string) {
    const q = encodeURIComponent(uri);
    return this.get<{ nodes: Array<{ id: string; payload: Record<string, unknown> }> }>(
      `/pvfs/locations/by-uri?uri=${q}`,
    );
  }

  /** All known file:// URIs (for scan dedup). */
  async getIngestedUriSet(): Promise<Set<string>> {
    const set = new Set<string>();
    const resp = await this.get<{ nodes: Array<{ payload: { uri?: string } }> }>("/pvfs/locations");
    for (const n of resp.nodes ?? []) {
      if (n.payload?.uri) set.add(n.payload.uri);
    }
    return set;
  }

  async startPvfsScan(body: {
    path: string;
    dry_run?: boolean;
    extensions?: string[];
    limit?: number;
    compute_hash?: boolean;
  }) {
    return this.post<{ jobId: string }>("/pvfs/scan", body);
  }

  async getPvfsScanJob(jobId: string) {
    return this.get<PvfsScanJobResponse>(`/pvfs/scan/${jobId}`);
  }

  async listPvfsOrphans() {
    return this.get<{ orphans: unknown[]; count: number }>("/pvfs/orphans");
  }

  async removeFromPrimary(fileNodeId: string, confirmLocalDelete?: boolean) {
    return this.delete<unknown>(
      `/pvfs/trees/primary/files/${fileNodeId}`,
      confirmLocalDelete ? { confirm_local_delete: true } : undefined,
    );
  }

  /** @deprecated Prefer ingestPvfsFile — hashes in MF and duplicates PV work. */
  async createPvfsFile(payload: {
    content_hash: string; size_bytes: number;
    mime_type: string; original_filename?: string; label: string;
  }) {
    return this.post<{ id: string }>("/pvfs/file", {
      label: payload.label,
      payload: {
        content_hash: payload.content_hash,
        size_bytes: payload.size_bytes,
        mime_type: payload.mime_type,
        original_filename: payload.original_filename ?? null,
      },
    });
  }

  async addPvfsLocation(fileNodeId: string, locationPayload: {
    type: string; uri: string; label?: string;
  }) {
    return this.post<unknown>(`/pvfs/file/${fileNodeId}/location`, {
      payload: { ...locationPayload, last_verified: null, last_seen: Date.now() },
    });
  }
}