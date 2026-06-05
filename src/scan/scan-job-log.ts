export interface ScanJobLogEntry {
  t: number;
  msg: string;
  [key: string]: unknown;
}

export interface ScanJobLogTarget {
  log?: ScanJobLogEntry[];
  last_log?: string;
}

export function appendScanJobLog(
  job: ScanJobLogTarget,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const entry: ScanJobLogEntry = { t: Date.now(), msg, ...meta };
  job.log = [...(job.log ?? []).slice(-100), entry];
  job.last_log = msg;
}