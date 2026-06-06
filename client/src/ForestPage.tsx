import { useState, useEffect, useCallback } from 'react'
import { api, UnauthorizedError } from './api'
import type { AdminStats, RawNode } from './api'

const LIMIT = 50

const TYPE_COLORS: Record<string, string> = {
  media:            'bg-blue-900 text-blue-300',
  storage_pointer:  'bg-green-900 text-green-300',
  crosslink:        'bg-purple-900 text-purple-300',
  watchlist_entry:  'bg-yellow-900 text-yellow-300',
}

const NODE_TYPES = ['', 'media', 'storage_pointer', 'crosslink', 'watchlist_entry']

interface Props {
  onClose: () => void
  onUnauthorized: () => void
}

export default function ForestPage({ onClose, onUnauthorized }: Props) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [nodes, setNodes] = useState<RawNode[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Local FS delete state (owner only)
  const [deletePath, setDeletePath] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteResult, setDeleteResult] = useState<{ deleted: string; wasDirectory: boolean } | null>(null)
  const [deleteError, setDeleteError] = useState('')

  useEffect(() => {
    api.adminStats()
      .then(setStats)
      .catch(err => { if (err instanceof UnauthorizedError) onUnauthorized() })
  }, [onUnauthorized])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  const loadNodes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.adminNodes({
        type: typeFilter || undefined,
        q: debouncedQuery || undefined,
        offset,
        limit: LIMIT,
      })
      setNodes(res.nodes)
      setTotal(res.total)
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized()
    } finally {
      setLoading(false)
    }
  }, [typeFilter, debouncedQuery, offset, onUnauthorized])

  useEffect(() => { loadNodes() }, [loadNodes])

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleTypeFilter(t: string) {
    setTypeFilter(t)
    setOffset(0)
    setExpanded(new Set())
  }

  function handleQuery(v: string) {
    setQuery(v)
    setOffset(0)
  }

  async function handleLocalDelete() {
    if (!deletePath.trim()) return
    if (!window.confirm(`Permanently DELETE ${deletePath} from local disk?\nThis cannot be undone and does not affect nodes or remote storage.`)) return

    setDeleting(true)
    setDeleteError('')
    setDeleteResult(null)
    try {
      const res = await api.deleteLocalStorage(deletePath.trim())
      setDeleteResult(res)
      setDeletePath('')
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized()
      else setDeleteError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">←</button>
        <h1 className="text-lg font-bold text-white">🌲 Forest Inspector</h1>
        <span className="text-xs text-gray-600">raw PVFS node store</span>
        <button
          onClick={loadNodes}
          className="ml-auto text-xs bg-gray-800 hover:bg-gray-700 rounded px-3 py-1.5"
        >
          ↻ Refresh
        </button>
      </header>

      {stats && (
        <div className="px-6 py-4 border-b border-gray-800">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
            <StatCard label="Store blocks" value={stats.storeBlocks} />
            <StatCard label="Indexed titles" value={stats.engineIndexed} />
            <StatCard label="media" value={stats.byType.media} color="text-blue-400" />
            <StatCard label="storage_ptr" value={stats.byType.storage_pointer} color="text-green-400" />
            <StatCard label="watchlist" value={stats.byType.watchlist_entry} color="text-yellow-400" />
            <StatCard label="crosslink" value={stats.byType.crosslink} color="text-purple-400" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-600">Feed key:</span>
            <span className="font-mono text-xs text-gray-500 break-all">{stats.feedKey}</span>
            {stats.byType.unknown > 0 && (
              <span className="ml-2 text-xs bg-yellow-900 text-yellow-300 rounded px-2 py-0.5">
                {stats.byType.unknown} unknown type{stats.byType.unknown !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {stats.storeBlocks !== Object.values(stats.byType).reduce((a, b) => a + b, 0) && (
            <div className="mt-2 text-xs text-yellow-400">
              ⚠ Store blocks ({stats.storeBlocks}) ≠ classified nodes ({Object.values(stats.byType).reduce((a, b) => a + b, 0)}) — possible index mismatch
            </div>
          )}
        </div>
      )}

      {/* Local FS delete tool (owner only; only for locally mounted media) */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/30">
        <h2 className="text-sm font-semibold text-red-400 mb-1">Local Media Filesystem Delete</h2>
        <p className="text-xs text-gray-500 mb-2">
          Permanently delete files/folders from the locally mounted media volume only.
          <strong> Does not work for remote storage</strong> (not implemented). 
          Current default mount is read-only — change to rw in compose if you need this.
          This deletes from disk only; corresponding nodes remain until cleaned (re-scan or Forest).
        </p>
        <div className="flex gap-2 items-center">
          <input
            value={deletePath}
            onChange={e => setDeletePath(e.target.value)}
            placeholder="path relative to /media (e.g. Movies/Bad.mkv or TV/ShowToRemove)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-red-500"
            disabled={deleting}
          />
          <button
            onClick={handleLocalDelete}
            disabled={deleting || !deletePath.trim()}
            className="px-4 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white rounded font-medium"
          >
            {deleting ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
        {deleteResult && <div className="mt-1 text-xs text-green-400">Deleted {deleteResult.deleted} {deleteResult.wasDirectory ? "(dir)" : ""}</div>}
        {deleteError && <div className="mt-1 text-xs text-red-400">{deleteError}</div>}
        <div className="mt-1 text-[10px] text-gray-600">Type a path and confirm in the dialog. Use with extreme caution.</div>
      </div>

      <div className="px-6 py-3 border-b border-gray-800 flex flex-wrap gap-3 items-center">
        <div className="flex gap-1 flex-wrap">
          {NODE_TYPES.map(t => (
            <button
              key={t || 'all'}
              onClick={() => handleTypeFilter(t)}
              className={`text-xs px-3 py-1.5 rounded transition-colors ${typeFilter === t ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              {t || 'all'}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={e => handleQuery(e.target.value)}
          placeholder="Search title, id, tmdb_id…"
          className="text-xs bg-gray-800 border border-gray-700 rounded px-3 py-1.5 w-52 focus:outline-none focus:border-indigo-500"
        />
        <span className="text-xs text-gray-500 ml-auto">
          {loading ? 'Loading…' : `${total} node${total !== 1 ? 's' : ''}`}
        </span>
      </div>

      <div className="px-6 py-4 space-y-1">
        {!loading && nodes.length === 0 && (
          <div className="text-center text-gray-600 py-12 text-sm">No nodes found</div>
        )}
        {nodes.map(node => (
          <NodeRow
            key={node.id}
            node={node}
            expanded={expanded.has(node.id)}
            onToggle={() => toggleExpand(node.id)}
            onSearchRelated={q => { handleTypeFilter(''); handleQuery(q) }}
          />
        ))}
      </div>

      {total > LIMIT && (
        <div className="px-6 pb-8 flex gap-3 items-center">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            className="text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded px-3 py-1.5"
          >
            ← Prev
          </button>
          <span className="text-xs text-gray-500">
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            disabled={offset + LIMIT >= total}
            onClick={() => setOffset(offset + LIMIT)}
            className="text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded px-3 py-1.5"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color = 'text-white' }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-gray-900 rounded-lg px-3 py-2">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  )
}

function nodeLabel(node: RawNode): string {
  const p = node.payload
  if (node.type === 'media') {
    const title = (p.title as string | undefined) ?? '?'
    const year = (p.year as number | undefined) ?? '?'
    const kind = (p.kind as string | undefined) ?? ''
    return `${title} (${year})${kind ? ' · ' + kind : ''}`
  }
  if (node.type === 'storage_pointer') {
    const mediaId = ((p.media_node_id as string | undefined) ?? '').slice(0, 10)
    const enc = (p.encoding as string | undefined) ?? ''
    const avail = p.available ? '✓' : '✗'
    const size = p.size_bytes ? ` · ${((p.size_bytes as number) / 1e9).toFixed(1)} GB` : ''
    return `→ ${mediaId}… ${enc} ${avail}${size}`
  }
  if (node.type === 'watchlist_entry') {
    const status = (p.status as string | undefined) ?? '?'
    const mediaId = ((p.media_node_id as string | undefined) ?? '').slice(0, 10)
    return `${status} → ${mediaId}…`
  }
  if (node.type === 'crosslink') {
    const mediaId = ((p.media_node_id as string | undefined) ?? '').slice(0, 10)
    return `crosslink → ${mediaId}…`
  }
  return node.id.slice(0, 24) + '…'
}

function NodeRow({ node, expanded, onToggle, onSearchRelated }: {
  node: RawNode
  expanded: boolean
  onToggle: () => void
  onSearchRelated: (q: string) => void
}) {
  const p = node.payload
  const hasRelated = node.type === 'media'

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-900 text-left"
      >
        <span className={`text-xs rounded px-1.5 py-0.5 shrink-0 font-mono ${TYPE_COLORS[node.type] ?? 'bg-gray-700 text-gray-300'}`}>
          {node.type}
        </span>
        <span className="text-sm text-gray-200 flex-1 min-w-0 truncate">{nodeLabel(node)}</span>
        {!!p.library && (
          <span className="text-xs text-gray-600 shrink-0">{String(p.library)}</span>
        )}
        <span className="font-mono text-xs text-gray-700 shrink-0">{node.id.slice(0, 8)}…</span>
        <span className="text-gray-600 text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-800">
          {hasRelated && (
            <div className="px-3 py-2 border-b border-gray-800 flex gap-2">
              <button
                onClick={() => onSearchRelated(node.id)}
                className="text-xs bg-gray-800 hover:bg-gray-700 rounded px-2 py-1"
              >
                Find related nodes →
              </button>
              {!!p.tmdb_id && (
                <span className="text-xs text-gray-500 self-center">TMDB: {String(p.tmdb_id)}</span>
              )}
              {!!p.imdb_id && (
                <span className="text-xs text-gray-500 self-center">IMDb: {String(p.imdb_id)}</span>
              )}
            </div>
          )}
          <pre className="px-4 py-3 bg-gray-950 text-xs text-gray-300 overflow-x-auto leading-relaxed">
            {JSON.stringify(node, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
