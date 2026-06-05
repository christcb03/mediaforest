import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ImportItemBody, StagedImportBatch } from './types.js';

export function stagedImportsPath(dataDir: string): string {
  return `${dataDir}/staged_imports.json`;
}

function loadAll(dataDir: string): StagedImportBatch[] {
  const p = stagedImportsPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as StagedImportBatch[];
  } catch {
    return [];
  }
}

function saveAll(dataDir: string, batches: StagedImportBatch[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stagedImportsPath(dataDir), JSON.stringify(batches, null, 2), { mode: 0o600 });
}

export function listStagedImports(dataDir: string): StagedImportBatch[] {
  return loadAll(dataDir).sort((a, b) => b.stagedAt - a.stagedAt);
}

export function getStagedImport(dataDir: string, id: string): StagedImportBatch | null {
  return loadAll(dataDir).find(b => b.id === id) ?? null;
}

export function createStagedImport(
  dataDir: string,
  stagedBy: string,
  items: ImportItemBody[],
  library?: string,
): StagedImportBatch {
  const batch: StagedImportBatch = {
    id: randomBytes(12).toString('hex'),
    stagedAt: Date.now(),
    stagedBy,
    library,
    itemCount: items.length,
    items,
  };
  const all = loadAll(dataDir);
  all.push(batch);
  saveAll(dataDir, all);
  return batch;
}

export function deleteStagedImport(dataDir: string, id: string): boolean {
  const all = loadAll(dataDir);
  const next = all.filter(b => b.id !== id);
  if (next.length === all.length) return false;
  saveAll(dataDir, next);
  return true;
}

export function clearAllStagedImports(dataDir: string): number {
  const n = loadAll(dataDir).length;
  if (n === 0) return 0;
  saveAll(dataDir, []);
  return n;
}