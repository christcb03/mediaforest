export type ImportMatchSource =
  | { source: 'tmdb'; tmdb_id: string; media_type: 'movie' | 'tv'; title: string; year: string; poster_path?: string | null }
  | { source: 'manual'; title: string; year: number | null; kind: 'movie' | 'series' };

export interface ImportFileBody {
  path: string;
  size_bytes: number;
  ext: string;
  already_ingested?: boolean;
  parsed: { title: string; year: number | null; kind: string; season: number | null; episode: number | null };
}

export interface ImportItemBody {
  kind: 'movie' | 'series';
  files: ImportFileBody[];
  selected_seasons?: number[] | null;
  match: ImportMatchSource;
  library?: string;
  tags?: string[];
}

export interface StagedImportBatch {
  id: string;
  stagedAt: number;
  stagedBy: string;
  library?: string;
  itemCount: number;
  items: ImportItemBody[];
}