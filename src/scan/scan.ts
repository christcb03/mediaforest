import { readdirSync, statSync, existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm',
  '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv', '.vob',
])

// Quality/release tags that appear in filenames but are not part of the title.
const NOISE = /\b(1080p|720p|480p|2160p|4k|uhd|bluray|blu-ray|bdrip|brrip|web-dl|webdl|webrip|hdtv|dvdrip|dvd|xvid|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|truehd|atmos|remux|repack|proper|extended|theatrical|unrated|directors|cut|hdr|hdr10|hdr10plus|dolby|vision|sdr|amzn|nf|hmax|dsnp|pcm|flac|yify|yts|rarbg|eztv|sample)\b/gi

export interface ParsedMedia {
  title: string
  year: number | null
  kind: 'movie' | 'series' | 'unknown'
  season: number | null
  episode: number | null
}

export interface ScannedFile {
  path: string
  size_bytes: number
  ext: string
  parsed: ParsedMedia
  already_ingested?: boolean
  local_artwork?: string | null  // absolute path to a sibling poster/folder image
}

export function parseMediaPath(filePath: string): ParsedMedia {
  const ext = path.extname(filePath)
  const basename = path.basename(filePath, ext)
  const parentDir = path.basename(path.dirname(filePath))

  // ── Plex standard series: "Series Title - s01e01 - Episode Title"
  // ── Plex multi-episode:   "Series Title - s01e01-e03 - Episode Title"
  // Check BEFORE dot-normalization so Plex's proper-cased titles are preserved.
  const plexSeries = basename.match(/^(.+?)\s+-\s+[Ss](\d{1,2})[Ee](\d{1,2})(?:-[Ee]\d{1,2})?(?:\s+-\s+.*)?$/)
  if (plexSeries) {
    return {
      title: plexSeries[1].trim(),
      year: null,
      kind: 'series',
      season: parseInt(plexSeries[2], 10),
      episode: parseInt(plexSeries[3], 10),
    }
  }

  // ── Plex daily: "Series Title - 2013-10-30 - Episode Title"
  const plexDaily = basename.match(/^(.+?)\s+-\s+(\d{4})-\d{2}-\d{2}(?:\s+-\s+.*)?$/)
  if (plexDaily) {
    return {
      title: plexDaily[1].trim(),
      year: parseInt(plexDaily[2], 10),
      kind: 'series',
      season: null,
      episode: null,
    }
  }

  // ── Normalize separators for non-Plex files (dots/underscores → spaces)
  let name = basename.replace(/[._]+/g, ' ').trim()

  // ── Generic SxxExx (e.g. dot-separated: Show.Name.S01E01.mkv)
  const tvMatch = name.match(/^(.*?)\s*[Ss](\d{1,2})[Ee](\d{1,2})/i)
  if (tvMatch) {
    let rawTitle = tvMatch[1].replace(/[-\s]+$/, '').trim()
    if (!rawTitle) {
      rawTitle = parentDir.replace(/[._]+/g, ' ').replace(/\bSeason\s*\d+\b/i, '').trim()
    }
    return {
      title: cleanTitle(rawTitle) || rawTitle || basename,
      year: null,
      kind: 'series',
      season: parseInt(tvMatch[2], 10),
      episode: parseInt(tvMatch[3], 10),
    }
  }

  // ── Movie: year in parens — Plex standard "Movie Title (Year)"
  let year: number | null = null
  let titlePart = name

  const parenYear = name.match(/\(((19|20)\d{2})\)/)
  if (parenYear) {
    year = parseInt(parenYear[1], 10)
    titlePart = name.slice(0, parenYear.index!).trim()
  } else {
    const bareYear = name.match(/(?<!\d)((19|20)\d{2})(?!\d)/)
    if (bareYear) {
      year = parseInt(bareYear[1], 10)
      titlePart = name.slice(0, bareYear.index!).trim()
    }
  }

  return {
    title: cleanTitle(titlePart) || cleanTitle(name) || basename,
    year,
    kind: year ? 'movie' : 'unknown',
    season: null,
    episode: null,
  }
}

function cleanTitle(s: string): string {
  return s
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[-–:,]+$/, '')
    .trim()
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

/** Poster/folder.jpg in the same directory as the media file (for ambiguous TMDB matches). */
export function findLocalArtwork(filePath: string, title: string): string | null {
  const dir = path.dirname(filePath)
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, '').trim()
  const basenames = ['poster', 'folder', safeTitle]
  for (const base of basenames) {
    for (const ext of IMAGE_EXTENSIONS) {
      const candidate = path.join(dir, base + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function scanVideoFiles(
  dir: string,
  extensions: Set<string> = DEFAULT_VIDEO_EXTENSIONS,
): ScannedFile[] {
  const results: ScannedFile[] = []

  function walk(current: string) {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry)
      let st
      try {
        st = statSync(fullPath)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(fullPath)
      } else if (st.isFile()) {
        const ext = path.extname(entry).toLowerCase()
        if (extensions.has(ext)) {
          const parsed = parseMediaPath(fullPath)
          results.push({
            path: fullPath,
            size_bytes: st.size,
            ext,
            parsed,
            local_artwork: findLocalArtwork(fullPath, parsed.title),
          })
        }
      }
    }
  }

  walk(dir)
  return results
}

// Async version for large/network-mounted libraries. Yields control between
// each directory so the event loop isn't blocked while waiting on NFS I/O.
// onFile fires for every discovered file — use it to stream results to a job
// object without waiting for the full scan to finish. Return false to stop walking.
export interface ScanWalkProgress {
  videoFilesSeen: number;
  dirsScanned: number;
  entriesScanned: number;
  currentDir: string;
}

const READDIR_TIMEOUT_ROOT_MS = 3 * 60 * 1000
const READDIR_TIMEOUT_MS = 90 * 1000

export async function scanVideoFilesAsync(
  dir: string,
  extensions: Set<string> = DEFAULT_VIDEO_EXTENSIONS,
  onProgress?: (progress: ScanWalkProgress) => void,
  onFile?: (file: ScannedFile) => boolean | void,
  opts?: {
    skipArtwork?: boolean
    shouldAbort?: () => string | null | undefined
    /** Fires before each readdir attempt — use to touch stall watchdogs on slow NFS mounts. */
    onEnterDir?: (dir: string, attempt: number) => void
  },
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = []
  const skipArtwork = opts?.skipArtwork !== false
  let dirsScanned = 0
  let entriesScanned = 0
  let ops = 0

  const emitProgress = (currentDir: string) => {
    onProgress?.({
      videoFilesSeen: results.length,
      dirsScanned,
      entriesScanned,
      currentDir,
    })
  }

  function isReaddirTimeout(err: unknown): boolean {
    return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
  }

  async function readdirTimed(readPath: string, timeoutMs: number): Promise<Dirent[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        readdir(readPath, { withFileTypes: true }),
        new Promise<Dirent[]>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`readdir timeout after ${timeoutMs}ms`)
            err.name = 'TimeoutError'
            reject(err)
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function readDirWithRetry(readPath: string, isRoot: boolean): Promise<Dirent[]> {
    const attempts = isRoot ? 5 : 2
    const timeoutMs = isRoot ? READDIR_TIMEOUT_ROOT_MS : READDIR_TIMEOUT_MS
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      opts?.onEnterDir?.(readPath, i + 1)
      try {
        return await readdirTimed(readPath, timeoutMs)
      } catch (err) {
        lastErr = err
        if (i + 1 < attempts) await new Promise<void>(r => setTimeout(r, 500 * (i + 1)))
      }
    }
    throw lastErr
  }

  async function walk(current: string, isRoot = false): Promise<boolean> {
    let entries: Dirent[]
    try {
      entries = await readDirWithRetry(current, isRoot)
    } catch (err) {
      if (isRoot) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          isReaddirTimeout(err)
            ? `Timed out listing ${current} after ${READDIR_TIMEOUT_ROOT_MS / 1000}s — NFS mount may be slow or hung`
            : `Cannot read directory ${current}: ${detail}`,
        )
      }
      return false
    }
    dirsScanned++
    emitProgress(current)

    for (const dirent of entries) {
      const abortMsg = opts?.shouldAbort?.()
      if (abortMsg) throw new Error(abortMsg)

      entriesScanned++
      if (++ops % 48 === 0) {
        emitProgress(current)
        await new Promise<void>(r => setImmediate(r))
      }

      const entry = dirent.name
      const fullPath = path.join(current, entry)
      let isDir = dirent.isDirectory()
      let isFile = dirent.isFile()

      // Some mounts omit d_type in readdir — fall back to stat only when needed.
      if (!isDir && !isFile) {
        try {
          const st = await stat(fullPath)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch {
          continue
        }
      }

      if (isDir) {
        if (await walk(fullPath)) return true
      } else if (isFile) {
        const ext = path.extname(entry).toLowerCase()
        if (extensions.has(ext)) {
          let sizeBytes = 0
          try {
            sizeBytes = (await stat(fullPath)).size
          } catch {
            continue
          }
          const parsed = parseMediaPath(fullPath)
          const file: ScannedFile = {
            path: fullPath,
            size_bytes: sizeBytes,
            ext,
            parsed,
            local_artwork: skipArtwork ? null : findLocalArtwork(fullPath, parsed.title),
          }
          if (onFile?.(file) === false) return true
          results.push(file)
          emitProgress(current)
        }
      }
    }
    return false
  }

  await walk(dir, true)
  return results
}
