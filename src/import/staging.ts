import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ImportItemBody, StagedImportBatch, ImportFileBody } from './types.js';

function normalizeScanPath(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

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

/** One auto-saved batch per scan path (updated as the scan discovers files). */
export function upsertScanStagedBatch(
  dataDir: string,
  stagedBy: string,
  scanPath: string,
  library: string | undefined,
  scanFiles: ImportFileBody[],
  status: 'scan_in_progress' | 'ready',
): StagedImportBatch {
  const key = normalizeScanPath(scanPath);
  const all = loadAll(dataDir);
  const idx = all.findIndex(b => b.scanPath === key);
  const batch: StagedImportBatch = {
    id: idx >= 0 ? all[idx].id : randomBytes(12).toString('hex'),
    stagedAt: Date.now(),
    stagedBy,
    library,
    itemCount: idx >= 0 ? all[idx].itemCount : 0,
    items: idx >= 0 ? all[idx].items : [],
    scanPath: key,
    status,
    scanFiles,
  };
  if (idx >= 0) all[idx] = batch;
  else all.push(batch);
  saveAll(dataDir, all);
  return batch;
}

export function getScanStagedBatch(dataDir: string, scanPath: string): StagedImportBatch | null {
  const key = normalizeScanPath(scanPath);
  return loadAll(dataDir).find(b => b.scanPath === key) ?? null;
}

export function updateStagedBatchItems(
  dataDir: string,
  batchId: string,
  items: ImportItemBody[],
): StagedImportBatch | null {
  const all = loadAll(dataDir);
  const idx = all.findIndex(b => b.id === batchId);
  if (idx < 0) return null;
  all[idx] = {
    ...all[idx],
    items,
    itemCount: items.length,
    status: items.length > 0 ? 'ready' : all[idx].status,
    stagedAt: Date.now(),
  };
  saveAll(dataDir, all);
  return all[idx];
}