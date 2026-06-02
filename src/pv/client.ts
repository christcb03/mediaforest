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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.ensureAuth();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      // Token expired — re-auth once and retry
      this.token = null;
      return this.request<T>(method, path, body);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PV ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  get<T>(path: string) { return this.request<T>("GET", path); }
  post<T>(path: string, body?: unknown) { return this.request<T>("POST", path, body); }
  put<T>(path: string, body?: unknown) { return this.request<T>("PUT", path, body); }
  delete<T>(path: string) { return this.request<T>("DELETE", path); }

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

  // ── PVFS helpers ───────────────────────────────────────────────────────────

  async getPvfsFile(nodeId: string) {
    return this.get<unknown>(`/pvfs/file/${nodeId}`);
  }

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

  async getTmdbToken(): Promise<string> {
    try {
      const providers = await this.getProviders() as Array<{ provider_id: string; config: Record<string, unknown> }>;
      const tmdb = providers.find(p => p.provider_id === "tmdb");
      return (tmdb?.config["read_access_token"] as string | undefined) ?? "";
    } catch {
      return "";
    }
  }
}
