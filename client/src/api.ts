export const BASE = import.meta.env.DEV ? '/api' : '';

export const TOKEN_KEY = 'pv_token';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class UnauthorizedError extends Error {}

/** Prefer server `error` or Fastify `message` (avoids generic "Internal Server Error"). */
function apiErrorMessage(
  body: { error?: string; message?: string } | null,
  status: number,
  statusText: string,
): string {
  if (!body) return `${status} ${statusText}`;
  const msg = body.message?.trim();
  const err = body.error?.trim();
  if (msg && msg !== 'Internal Server Error') return msg;
  if (err && err !== 'Internal Server Error') return err;
  return msg || err || `${status} ${statusText}`;
}

export interface MediaSource {
  storageNodeId: string;
  endpointUrl: string;
  encoding: string;
  available: boolean;
  sizeBytes: number;
  feedOwner: string;
}

export interface WatchlistInfo {
  status: 'unwatched' | 'watching' | 'watched' | 'skipped';
  addedAt: number;
  progressMs?: number;
}

export interface MediaResult {
  id: string;
  title: string;
  year: number;
  kind: 'movie' | 'series' | 'episode' | 'short';
  genres?: string[];
  imdb_id?: string;
  poster_path?: string | null;
  library?: string;
  tags?: string[];
  sources: MediaSource[];
  bestSource: { endpointUrl: string; encoding: string } | null;
  watchlist: WatchlistInfo | null;
}

export interface LibraryRecord {
  id: string;
  name: string;
  color?: string;
  defaultPath?: string;
}

export interface SectionFilter {
  library?: string;
  genre?: string;
  watchStatus?: string;
  kind?: string;
  available?: boolean;
}

export interface SectionRecord {
  id: string;
  name: string;
  view: 'row' | 'grid';
  filter: SectionFilter;
  sort?: 'addedAt' | 'year' | 'title';
}

export interface SearchResponse {
  count: number;
  results: MediaResult[];
}

export interface HealthResponse {
  status: string;
  identity: string;
  feedLength: number;
  following: number;
  indexed: number;
  hasOwner?: boolean;
}

export interface AuthStatusResponse {
  hasOwner: boolean;
}

export interface LoginResponse {
  token: string;
  identity: string;
  userPubKey: string;
  userRole: 'owner' | 'member';
  userName: string | null;
}

export interface UserRecord {
  pubKey: string;
  name: string | null;
  role: 'owner' | 'member';
  createdAt: number;
  hasRecovery?: boolean;
}

export interface AuthConfig {
  registrationMode: 'open' | 'closed';
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) throw new UnauthorizedError('session expired');
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(body, res.status, res.statusText));
  }
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError('session expired');
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(errBody, res.status, res.statusText));
  }
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (res.status === 401) throw new UnauthorizedError('session expired');
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(body, res.status, res.statusText));
  }
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError('session expired');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export interface TmdbSearchResult {
  tmdb_id: string;
  media_type: 'movie' | 'tv';
  title: string;
  year: string;
  poster_path: string | null;
  overview: string | null;
}

export interface TmdbDetails extends TmdbSearchResult {
  genres: string[];
  imdb_id?: string;
  tvdb_id?: string;
  runtime_min?: number;
}

export type WatchStatus = 'unwatched' | 'watching' | 'watched' | 'skipped';

export interface ProviderConfig {
  node_id: string;
  provider_id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ScannedFile {
  path: string;
  size_bytes: number;
  ext: string;
  already_ingested?: boolean;
  local_artwork?: string | null;
  parsed: {
    title: string;
    year: number | null;
    kind: 'movie' | 'series' | 'unknown';
    season: number | null;
    episode: number | null;
  };
}

export interface MatchCandidate {
  tmdb_id: string;
  media_type: 'movie' | 'tv';
  title: string;
  year: string;
  poster_path: string | null;
  overview: string | null;
  confidence: number;
}

export interface MatchSearchResult {
  query: { title: string; year: number | null; kind: 'movie' | 'series' | 'unknown' };
  candidates: MatchCandidate[];
  best: MatchCandidate | null;
  needs_review: boolean;
}

export type MatchSource =
  | { source: 'tmdb'; tmdb_id: string; media_type: 'movie' | 'tv'; title: string; year: string; poster_path: string | null; overview: string | null }
  | { source: 'manual'; title: string; year: number | null; kind: 'movie' | 'series' };

export interface ImportItem {
  kind: 'movie' | 'series';
  files: ScannedFile[];
  selected_seasons?: number[] | null;
  match: MatchSource;
  library?: string;
  tags?: string[];
}

export interface ImportResult {
  imported: number;
  failed: number;
  results: Array<{ mediaNodeId: string; title: string; fileCount: number }>;
  failures: Array<{ title: string; error: string }>;
}

export interface ScanResult {
  found: number;
  dry_run: true;
  files: ScannedFile[];
}

export interface IngestResult {
  found: number;
  dry_run: false;
  ingested: number;
  failed: number;
  files: Array<{ path: string; fileNodeId: string; contentHash: string; streamUrl: string }>;
  failures: Array<{ path: string; error: string }>;
}

export interface UnimportedFile {
  fileNodeId: string;
  filename: string;
  size_bytes: number;
  streamUrl: string;
  parsed: {
    title: string;
    year: number | null;
    kind: 'movie' | 'series' | 'unknown';
    season: number | null;
    episode: number | null;
  };
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError('session expired');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getPublic<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export interface AdminStats {
  feedKey: string;
  storeBlocks: number;
  byType: { media: number; storage_pointer: number; crosslink: number; watchlist_entry: number; unknown: number };
  engineIndexed: number;
}

export interface RawNode {
  id: string;
  type: string;
  author: string;
  sig: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface AdminNodesResponse {
  total: number;
  offset: number;
  limit: number;
  nodes: RawNode[];
}

export interface PlexSection {
  key: string;
  title: string;
  type: 'movie' | 'show';
  count: number;
}

export interface PlexImportResult {
  imported: number;
  watchSynced: number;
  skipped: number;
  failed: number;
  results: Array<{ title: string; mediaNodeId: string; action: string }>;
  failures: Array<{ title: string; error: string }>;
}

export const api = {
  health: () => fetch(`${BASE}/health`).then(r => r.json()) as Promise<HealthResponse>,
  authStatus: () => fetch(`${BASE}/auth/status`).then(r => r.json()) as Promise<AuthStatusResponse>,
  register: (pubKey: string, inviteToken?: string, name?: string, recoveryPassword?: string) =>
    postPublic<{ registered: boolean; serverIdentity: string; role: string }>(
      '/auth/register', { pubKey, inviteToken, name, recoveryPassword }
    ),
  recover: (recoveryPassword: string, newPubKey: string) =>
    postPublic<{ token: string; identity: string; userPubKey: string; userRole: 'owner' | 'member'; userName: string | null }>(
      '/auth/recover', { recoveryPassword, newPubKey }
    ),
  loginWithPassword: (password: string, name?: string) =>
    postPublic<{ token: string; identity: string; userPubKey: string; userRole: 'owner' | 'member'; userName: string | null }>(
      '/auth/login-password', { password, ...(name ? { name } : {}) }
    ),
  getLoginUsers: () =>
    getPublic<{ users: { name: string | null; hasPassword: boolean }[] }>('/auth/login-users'),
  createInvite: () => post<{ token: string; expiresAt: number }>('/auth/invite', {}),
  listUsers: () => get<{ users: UserRecord[] }>('/auth/users'),
  removeUser: (pubKey: string) => del<{ removed: boolean }>(`/auth/users/${pubKey}`),
  resetUserRecovery: (pubKey: string, recoveryPassword: string) =>
    post<{ updated: boolean }>(`/auth/users/${pubKey}/reset-recovery`, { recoveryPassword }),
  getAuthConfig: () => get<AuthConfig>('/auth/config'),
  setAuthConfig: (config: Partial<AuthConfig>) => patch<AuthConfig>('/auth/config', config),
  search: (params: { q?: string; kind?: string; available?: boolean; watchStatus?: string; library?: string; genre?: string }) => {
    const qs = new URLSearchParams();
    if (params.q)           qs.set('q', params.q);
    if (params.kind)        qs.set('kind', params.kind);
    if (params.available)   qs.set('available', 'true');
    if (params.watchStatus) qs.set('watchStatus', params.watchStatus);
    if (params.library)     qs.set('library', params.library);
    if (params.genre)       qs.set('genre', params.genre);
    return get<SearchResponse>(`/search?${qs}`);
  },
  getMedia: (id: string) => get<MediaResult>(`/media/${id}`),
  follow: (feedKey: string) => post('/follow', { feedKey }),
  following: () => get<{ keys: string[] }>('/following'),
  addMedia: (body: object) => post<{ id: string }>('/media', body),
  addStorage: (body: object) => post<{ id: string }>('/storage', body),
  addWatchlist: (body: object) => post('/watchlist', body),
  addCrosslink: (body: object) => post('/crosslink', body),
  updateWatchlist: (mediaId: string, status: WatchStatus, progressMs?: number) =>
    patch<{ id: string; status: string }>(`/watchlist/${mediaId}`, { status, progress_ms: progressMs }),
  tmdbSearch: (q: string) => get<{ results: TmdbSearchResult[] }>(`/tmdb/search?q=${encodeURIComponent(q)}`),
  tmdbDetails: (id: string, type: 'movie' | 'tv') => get<TmdbDetails>(`/tmdb/details?id=${id}&type=${type}`),
  getProviders: () => get<ProviderConfig[]>('/config/providers'),
  upsertProvider: (providerId: string, body: { read_access_token?: string; enabled?: boolean; name?: string; [key: string]: unknown }) =>
    put<{ provider_id: string; enabled: boolean; updated: boolean }>(`/config/providers/${providerId}`, body),
  pvfsUnimported: () => get<{ files: UnimportedFile[] }>('/pvfs/unimported'),
  pvfsScan: (body: { path: string; dry_run?: boolean; extensions?: string[]; limit?: number }) =>
    post<{ jobId: string }>('/pvfs/scan', body),
  pvfsScanJob: (jobId: string) =>
    get<{ status: 'running' | 'done' | 'error'; found: number; new_count?: number; already_ingested_count?: number; dry_run: boolean; files: ScannedFile[]; ingested?: number; failed?: number; failures?: Array<{ path: string; error: string }>; error?: string }>(`/pvfs/scan/job/${jobId}`),
  matchSearch: (body: { items: Array<{ title: string; year: number | null; kind: 'movie' | 'series' | 'unknown' }>; threshold?: number }) =>
    post<{ results: MatchSearchResult[]; threshold: number }>('/media/match/search', body),
  importBatch: (body: { items: ImportItem[]; library?: string; tags?: string[] }) =>
    post<ImportResult>('/media/import/batch', body),
  artworkUrl: (localPath: string) => `${BASE}/pvfs/artwork?path=${encodeURIComponent(localPath)}`,
  // Libraries
  getLibraries: () => get<{ libraries: LibraryRecord[] }>('/libraries'),
  createLibrary: (body: { name: string; color?: string; defaultPath?: string }) =>
    post<LibraryRecord>('/libraries', body),
  updateLibrary: (id: string, body: { name?: string; color?: string; defaultPath?: string }) =>
    patch<LibraryRecord>(`/libraries/${id}`, body),
  deleteLibrary: (id: string) => del<{ removed: boolean }>(`/libraries/${id}`),
  // Sections
  getSections: () => get<{ sections: SectionRecord[] }>('/config/sections'),
  createSection: (body: { name: string; view?: string; filter?: SectionFilter; sort?: string }) =>
    post<SectionRecord>('/config/sections', body),
  updateSection: (id: string, body: { name?: string; view?: string; filter?: SectionFilter; sort?: string }) =>
    patch<SectionRecord>(`/config/sections/${id}`, body),
  deleteSection: (id: string) => del<{ removed: boolean }>(`/config/sections/${id}`),
  reorderSections: (ids: string[]) => post<{ sections: SectionRecord[] }>('/config/sections/reorder', { ids }),
  // Plex
  plexStatus: () => get<{ connected: boolean; version: string }>('/plex/status'),
  plexLibraries: () => get<{ sections: PlexSection[] }>('/plex/libraries'),
  plexImport: (body: { sectionKey: string; library?: string; syncWatchStatus?: boolean; tags?: string[] }) =>
    post<PlexImportResult>('/plex/import', body),
  plexSyncWatch: () => post<{ updated: number; skipped: number }>('/plex/sync-watch', {}),
  // Admin
  adminStats: () => get<AdminStats>('/admin/stats'),
  adminNodes: (params: { type?: string; q?: string; offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.type)              qs.set('type', params.type);
    if (params.q)                 qs.set('q', params.q);
    if (params.offset != null)    qs.set('offset', String(params.offset));
    if (params.limit != null)     qs.set('limit', String(params.limit));
    return get<AdminNodesResponse>(`/admin/nodes?${qs}`);
  },
  // Import staging
  listStagedImports: () => get<{ batches: StagedBatchSummary[] }>('/import/staged'),
  stageImport: (body: { items: ImportItem[]; library?: string }) =>
    post<{ id: string; stagedAt: number; itemCount: number }>('/import/stage', body),
  commitStagedImport: (id: string) =>
    post<ImportResult & { stagedId: string }>(`/import/commit/${id}`, {}),
  discardStagedImport: (id: string) => del<{ discarded: boolean }>(`/import/staged/${id}`),
  // Factory reset (owner)
  factoryResetPreview: () => get<FactoryResetPreview>('/admin/factory-reset/preview'),
  factoryReset: (body: FactoryResetRequest) =>
    post<{ ok: boolean; summary: Record<string, unknown> }>('/admin/factory-reset', body),
};

export const FACTORY_RESET_PHRASE = 'DELETE ALL MEDIA DATA';

export interface StagedBatchSummary {
  id: string;
  stagedAt: number;
  stagedBy: string;
  library?: string;
  itemCount: number;
  mine: boolean;
}

export interface FactoryResetPreview {
  warning: string;
  confirmation_phrase_required: string;
  hypercore_nodes: number;
  member_accounts: number;
  invites_pending: number;
  staged_import_batches: number;
  followed_feeds: number;
  libraries_defined: number;
  actions: string[];
}

export interface FactoryResetRequest {
  confirmation_phrase: string;
  acknowledge_irreversible: boolean;
  acknowledge_remove_all_members: boolean;
  acknowledge_remove_pvfs_inventory: boolean;
}
