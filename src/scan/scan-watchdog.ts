/** Tracks scan jobs for overall timeout and stall detection. */

export const SCAN_MAX_DURATION_MS = 20 * 60 * 1000;
/** NFS/metadata-heavy roots can block on readdir/stat far longer than 90s. */
export const SCAN_STALL_MS = 5 * 60 * 1000;

export interface ScanWatchdogJob {
  status: string;
  startedAt: number;
  phase?: string;
  current_dir?: string;
  scanPath: string;
}

export function startScanWatchdog(
  job: ScanWatchdogJob,
  onAbort: (message: string) => void,
): { touch: () => void; stop: () => void; isAborted: () => boolean } {
  let lastProgress = Date.now();
  let aborted = false;

  const timer = setInterval(() => {
    if (job.status !== 'running') return;
    const now = Date.now();
    if (now - job.startedAt > SCAN_MAX_DURATION_MS) {
      aborted = true;
      onAbort(
        `Scan exceeded ${SCAN_MAX_DURATION_MS / 60_000} minutes during `
        + `${job.phase ?? 'scan'} at ${job.current_dir ?? job.scanPath}`,
      );
    } else if (now - lastProgress > SCAN_STALL_MS) {
      aborted = true;
      onAbort(
        `No progress for ${SCAN_STALL_MS / 1000}s during `
        + `${job.phase ?? 'scan'} at ${job.current_dir ?? job.scanPath}`,
      );
    }
  }, 3000);

  return {
    touch: () => { lastProgress = Date.now(); },
    stop: () => clearInterval(timer),
    isAborted: () => aborted,
  };
}