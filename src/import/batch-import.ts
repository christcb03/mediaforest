import path from 'node:path';
import type { RelayQueryEngine } from '../relay/query.js';
import type { HypercoreStore } from '../store/hypercore.js';
import { createMediaNode, createStoragePointerNode } from '../relay/index.js';
import type { ImportItemBody } from './types.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

export interface BatchImportDeps {
  engine: RelayQueryEngine;
  ownStore: HypercoreStore;
  privKeyHex: string;
  ingestFile: (filePath: string, opts: { label?: string; mediaNodeId?: string }) => Promise<{
    fileNode: { id: string; payload: { content_hash: string; size_bytes: number; mime_type: string } };
  }>;
  getTmdbToken: (pubKey: string) => string;
  tmdbHeaders: (token: string) => Record<string, string>;
  guessEncoding: (filePath: string) => string;
}

export interface BatchImportResult {
  imported: number;
  failed: number;
  results: Array<{ mediaNodeId: string; title: string; fileCount: number }>;
  failures: Array<{ title: string; error: string }>;
}

export async function runBatchImport(
  deps: BatchImportDeps,
  items: ImportItemBody[],
  importUserPubKey: string,
): Promise<BatchImportResult> {
  const results: BatchImportResult['results'] = [];
  const failures: BatchImportResult['failures'] = [];

  for (const item of items) {
    const itemTitle = item.match.title;
    try {
      let mediaNodeId: string;

      if (item.match.source === 'tmdb') {
        const tmdbMatch = item.match;
        const existing = deps.engine.search({}).find(r => r.media.payload.tmdb_id === tmdbMatch.tmdb_id);
        if (existing) {
          mediaNodeId = existing.media.id;
        } else {
          let genres: string[] | undefined;
          let imdbId: string | undefined;
          let tvdbId: string | undefined;
          let runtimeMin: number | undefined;
          try {
            const token = deps.getTmdbToken(importUserPubKey);
            if (token) {
              const segment = tmdbMatch.media_type === 'tv' ? 'tv' : 'movie';
              const res = await fetch(
                `${TMDB_BASE}/${segment}/${tmdbMatch.tmdb_id}?append_to_response=external_ids`,
                { headers: deps.tmdbHeaders(token) },
              );
              const d = await res.json() as Record<string, unknown>;
              genres = ((d.genres as { name: string }[] | undefined) ?? []).map(g => g.name);
              const extIds = (d.external_ids ?? {}) as Record<string, unknown>;
              imdbId = (d.imdb_id ?? extIds.imdb_id) as string | undefined;
              tvdbId = extIds.tvdb_id ? String(extIds.tvdb_id) : undefined;
              runtimeMin = tmdbMatch.media_type === 'movie'
                ? d.runtime as number | undefined
                : (d.episode_run_time as number[] | undefined)?.[0];
            }
          } catch { /* enrichment optional */ }

          const kind = tmdbMatch.media_type === 'tv' ? 'series' : 'movie';
          const node = await createMediaNode(deps.privKeyHex, {
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
          await deps.ownStore.append(node);
          mediaNodeId = node.id;
        }
      } else {
        const kind = item.kind === 'series' ? 'series' : 'movie';
        const node = await createMediaNode(deps.privKeyHex, {
          title: item.match.title,
          year: item.match.year ?? 0,
          kind,
          library: item.library,
          tags: item.tags,
        });
        await deps.ownStore.append(node);
        mediaNodeId = node.id;
      }

      let fileCount = 0;
      for (const file of item.files) {
        if (file.already_ingested) continue;
        try {
          const { fileNode } = await deps.ingestFile(file.path, {
            label: file.parsed.title || path.basename(file.path),
          });
          const storageNode = await createStoragePointerNode(deps.privKeyHex, {
            media_node_id: mediaNodeId,
            endpoint_url: `/stream/${fileNode.id}`,
            content_hash: fileNode.payload.content_hash,
            size_bytes: file.size_bytes,
            encoding: deps.guessEncoding(file.path),
            container: file.ext.replace('.', '') || 'mkv',
            available: true,
          });
          await deps.ownStore.append(storageNode);
          fileCount++;
        } catch { /* per-file */ }
      }

      results.push({ mediaNodeId, title: itemTitle, fileCount });
    } catch (err) {
      failures.push({ title: itemTitle, error: err instanceof Error ? err.message : 'import failed' });
    }
  }

  await deps.engine.refresh();
  return { imported: results.length, failed: failures.length, results, failures };
}