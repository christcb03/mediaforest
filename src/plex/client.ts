/**
 * Plex Media Server API client.
 *
 * Uses the local Plex HTTP API with X-Plex-Token auth.
 * All responses are JSON (Accept: application/json).
 */

export interface PlexSection {
  key: string;
  title: string;
  type: "movie" | "show";
  count: number;
}

export interface PlexPart {
  id: string;
  key: string;      // e.g. /library/parts/12345/file
  size: number;
  container: string; // mkv, mp4, etc.
  file: string;     // local path on Plex server (informational)
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  originalTitle?: string;
  year: number;
  type: "movie" | "show";
  viewCount: number;
  lastViewedAt?: number;   // unix seconds
  addedAt: number;         // unix seconds
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  thumb?: string;          // Plex-relative poster path
  parts: PlexPart[];
}

export class PlexClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(serverUrl: string, token: string) {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("X-Plex-Token", this.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Plex API ${res.status}: ${path}`);
    return res.json() as Promise<T>;
  }

  async ping(): Promise<{ version: string }> {
    const data = await this.get<{ MediaContainer: { version: string } }>("/");
    return { version: data.MediaContainer.version };
  }

  async getSections(): Promise<PlexSection[]> {
    const data = await this.get<{
      MediaContainer: { Directory: Array<{ key: string; title: string; type: string; size: number }> };
    }>("/library/sections");

    return (data.MediaContainer.Directory ?? [])
      .filter(d => d.type === "movie" || d.type === "show")
      .map(d => ({
        key: d.key,
        title: d.title,
        type: d.type as "movie" | "show",
        count: d.size ?? 0,
      }));
  }

  async getSectionItems(sectionKey: string): Promise<PlexItem[]> {
    const data = await this.get<{
      MediaContainer: { Metadata: PlexRawItem[] };
    }>(`/library/sections/${sectionKey}/all`);

    return (data.MediaContainer.Metadata ?? []).map(item => this.parseItem(item));
  }

  private parseItem(raw: PlexRawItem): PlexItem {
    const guids = raw.Guid ?? [];
    let tmdbId: string | undefined;
    let imdbId: string | undefined;
    let tvdbId: string | undefined;

    for (const g of guids) {
      const id = g.id ?? "";
      if (id.startsWith("tmdb://")) tmdbId = id.slice(7);
      else if (id.startsWith("imdb://")) imdbId = id.slice(7);
      else if (id.startsWith("tvdb://")) tvdbId = id.slice(7);
    }

    // Older Plex agents encode IDs differently
    if (!tmdbId && !imdbId) {
      const guid = raw.guid ?? "";
      const imdbMatch = guid.match(/imdb:\/\/(tt\d+)/);
      const tmdbMatch = guid.match(/themoviedb:\/\/(\d+)/);
      if (imdbMatch) imdbId = imdbMatch[1];
      if (tmdbMatch) tmdbId = tmdbMatch[1];
    }

    const parts: PlexPart[] = (raw.Media ?? []).flatMap(m =>
      (m.Part ?? []).map(p => ({
        id: String(p.id),
        key: p.key,
        size: p.size ?? 0,
        container: m.container ?? "mkv",
        file: p.file ?? "",
      }))
    );

    return {
      ratingKey: raw.ratingKey,
      title: raw.title,
      originalTitle: raw.originalTitle,
      year: raw.year ?? 0,
      type: raw.type === "show" ? "show" : "movie",
      viewCount: raw.viewCount ?? 0,
      lastViewedAt: raw.lastViewedAt,
      addedAt: raw.addedAt ?? 0,
      tmdbId,
      imdbId,
      tvdbId,
      thumb: raw.thumb,
      parts,
    };
  }

  /** Direct-play URL for a Plex part. */
  directPlayUrl(partKey: string): string {
    return `${this.baseUrl}${partKey}?X-Plex-Token=${this.token}`;
  }

  /** Poster URL for a Plex item. */
  posterUrl(thumb: string): string {
    return `${this.baseUrl}${thumb}?X-Plex-Token=${this.token}`;
  }
}

// ── Raw Plex API shapes ──────────────────────────────────────────────────────

interface PlexRawItem {
  ratingKey: string;
  title: string;
  originalTitle?: string;
  year?: number;
  type: string;
  viewCount?: number;
  lastViewedAt?: number;
  addedAt?: number;
  thumb?: string;
  guid?: string;           // legacy single GUID
  Guid?: Array<{ id: string }>;  // modern multi-GUID
  Media?: Array<{
    container?: string;
    Part?: Array<{ id: number; key: string; size?: number; file?: string }>;
  }>;
}
