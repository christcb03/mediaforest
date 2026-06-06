import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { ScannedFile } from '../scan/scan.js';

export interface ScanSession {
  scanPath: string;
  library?: string;
  updatedAt: number;
  status: 'scanning' | 'complete';
  files: ScannedFile[];
}

function sessionPath(dataDir: string): string {
  return `${dataDir}/scan_sessions.json`;
}

export function normalizeScanPath(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

function normalizePath(p: string): string {
  return normalizeScanPath(p);
}

function loadMap(dataDir: string): Record<string, ScanSession> {
  const p = sessionPath(dataDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, ScanSession>;
  } catch {
    return {};
  }
}

function saveMap(dataDir: string, map: Record<string, ScanSession>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(sessionPath(dataDir), JSON.stringify(map, null, 2), { mode: 0o600 });
}

export function getScanSession(dataDir: string, scanPath: string): ScanSession | null {
  return loadMap(dataDir)[normalizePath(scanPath)] ?? null;
}

export function upsertScanSession(
  dataDir: string,
  scanPath: string,
  patch: Partial<Pick<ScanSession, 'library' | 'status' | 'files'>>,
): ScanSession {
  const key = normalizePath(scanPath);
  const map = loadMap(dataDir);
  const prev = map[key];
  const session: ScanSession = {
    scanPath: key,
    library: patch.library ?? prev?.library,
    updatedAt: Date.now(),
    status: patch.status ?? prev?.status ?? 'scanning',
    files: patch.files ?? prev?.files ?? [],
  };
  map[key] = session;
  saveMap(dataDir, map);
  return session;
}

export function deleteScanSession(dataDir: string, scanPath: string): boolean {
  const key = normalizePath(scanPath);
  const map = loadMap(dataDir);
  if (!map[key]) return false;
  delete map[key];
  saveMap(dataDir, map);
  return true;
}

export function sessionPathSet(session: ScanSession | null): Set<string> {
  return new Set((session?.files ?? []).map(f => f.path));
}