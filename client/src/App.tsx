import { useState, useEffect, useCallback } from 'react'
import { api, BASE, TOKEN_KEY, UnauthorizedError } from './api'
import type { MediaResult, HealthResponse, WatchStatus, LoginResponse, SectionRecord } from './api'

const TMDB_IMG = 'https://image.tmdb.org/t/p/w92'
import LoginPage from './LoginPage'
import AddMediaModal from './AddMediaModal'
import SettingsPage from './SettingsPage'
import ScanPage from './ScanPage'
import PlexSyncPage from './PlexSyncPage'
import ForestPage from './ForestPage'

const USER_KEY = 'pv_user'

export default function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))
  const [currentUser, setCurrentUser] = useState<{ pubKey: string; role: string; name: string | null } | null>(
    () => { try { return JSON.parse(sessionStorage.getItem(USER_KEY) ?? 'null') } catch { return null } }
  )
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MediaResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<MediaResult | null>(null)
  const [followKey, setFollowKey] = useState('')
  const [followMsg, setFollowMsg] = useState('')
  const [showAddMedia, setShowAddMedia] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showScan, setShowScan] = useState(false)
  const [showPlex, setShowPlex] = useState(false)
  const [showForest, setShowForest] = useState(false)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [showInvite, setShowInvite] = useState(false)
  const [sections, setSections] = useState<SectionRecord[]>([])
  const [sectionsLoading, setSectionsLoading] = useState(true)
  const [sectionResultsLoading, setSectionResultsLoading] = useState(false)
  const [sectionResults, setSectionResults] = useState<Map<string, MediaResult[]>>(new Map())

  function handleLogin(resp: LoginResponse) {
    sessionStorage.setItem(TOKEN_KEY, resp.token)
    const user = { pubKey: resp.userPubKey, role: resp.userRole, name: resp.userName }
    sessionStorage.setItem(USER_KEY, JSON.stringify(user))
    setToken(resp.token)
    setCurrentUser(user)
  }

  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
    setToken(null)
    setCurrentUser(null)
  }

  function handleUnauthorized() {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
    setToken(null)
    setCurrentUser(null)
  }

  async function handleCreateInvite() {
    try {
      const { token: t } = await api.createInvite()
      setInviteToken(t)
      setShowInvite(true)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!token) return
    api.health().then(setHealth).catch(() => {})
  }, [token])

  // Fetch results for a given list of sections and update state
  async function fetchSectionResults(secs: SectionRecord[]) {
    if (secs.length === 0) return
    setSectionResultsLoading(true)
    const map = new Map<string, MediaResult[]>()
    try {
      await Promise.all(secs.map(async s => {
        try {
          const params: Parameters<typeof api.search>[0] = {}
          if (s.filter.library) params.library = s.filter.library
          if (s.filter.genre) params.genre = s.filter.genre
          if (s.filter.watchStatus) params.watchStatus = s.filter.watchStatus
          if (s.filter.kind) params.kind = s.filter.kind
          if (s.filter.available) params.available = true
          const res = await api.search(params)
          let items = res.results
          if (s.sort === 'title') items = [...items].sort((a, b) => a.title.localeCompare(b.title))
          else if (s.sort === 'year') items = [...items].sort((a, b) => b.year - a.year)
          map.set(s.id, items)
        } catch { map.set(s.id, []) }
      }))
      setSectionResults(map)
    } finally {
      setSectionResultsLoading(false)
    }
  }

  // Load section config then immediately load their results — all inside one effect
  // so sectionsLoading stays true until both phases complete (no intermediate blank render)
  useEffect(() => {
    if (!token) return
    setSectionsLoading(true)
    api.getSections()
      .then(async r => {
        setSections(r.sections)
        await fetchSectionResults(r.sections)
      })
      .catch(() => {})
      .finally(() => setSectionsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // Full-text search (only when query is non-empty — collapses all sections)
  const search = useCallback(async () => {
    if (!token || !query) { setResults([]); return }
    setLoading(true)
    try {
      const res = await api.search({ q: query })
      setResults(res.results)
    } catch (err) {
      if (err instanceof UnauthorizedError) handleUnauthorized()
    } finally {
      setLoading(false)
    }
  }, [token, query])

  useEffect(() => { search() }, [search])

  // Explicit refresh — used after import, scan, settings close, etc.
  const loadSections = useCallback(async () => {
    if (!token) return
    try {
      const r = await api.getSections()
      setSections(r.sections)
      await fetchSectionResults(r.sections)
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (!token) return <LoginPage onLogin={handleLogin} />
  if (showSettings) return (
    <SettingsPage onClose={() => { setShowSettings(false); loadSections() }} onUnauthorized={handleUnauthorized} userRole={currentUser?.role as 'owner' | 'member' | undefined} />
  )
  if (showScan) return (
    <ScanPage onClose={() => { setShowScan(false); loadSections() }} onUnauthorized={handleUnauthorized} />
  )
  if (showPlex) return (
    <PlexSyncPage
      onClose={() => { setShowPlex(false) }}
      onUnauthorized={handleUnauthorized}
      onImportDone={loadSections}
    />
  )
  if (showForest) return (
    <ForestPage onClose={() => setShowForest(false)} onUnauthorized={handleUnauthorized} />
  )

  async function handleFollow(e: React.FormEvent) {
    e.preventDefault()
    try {
      await api.follow(followKey)
      setFollowMsg('Following! Reload to see their library.')
      setFollowKey('')
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) { handleUnauthorized(); return }
      setFollowMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-6">
        <h1 className="text-xl font-bold tracking-tight text-white">
          <span className="text-indigo-400">⬡</span> MediaForest
        </h1>
        {health && (
          <span className="text-xs text-gray-500">
            {health.indexed} titles · {health.following} peers · feed {health.feedLength}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <form onSubmit={handleFollow} className="flex gap-2">
            <input
              value={followKey}
              onChange={e => setFollowKey(e.target.value)}
              placeholder="Paste friend's feed key…"
              className="text-xs bg-gray-800 border border-gray-700 rounded px-3 py-1.5 w-64 focus:outline-none focus:border-indigo-500"
            />
            <button type="submit" className="text-xs bg-indigo-600 hover:bg-indigo-500 rounded px-3 py-1.5">
              Follow
            </button>
          </form>
          {followMsg && <span className="text-xs text-green-400">{followMsg}</span>}
          <button
            onClick={() => setShowAddMedia(true)}
            className="text-xs bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5"
          >
            + Add Media
          </button>
          <button
            onClick={() => setShowScan(true)}
            className="text-xs bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5"
          >
            📂 Scan
          </button>
          <button
            onClick={() => setShowPlex(true)}
            className="text-xs bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5"
          >
            🟠 Plex
          </button>
          {currentUser?.role === 'owner' && (
            <button
              onClick={() => setShowForest(true)}
              className="text-xs bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5"
              title="Forest Inspector — raw node store"
            >
              🌲 Forest
            </button>
          )}
          {currentUser?.role === 'owner' && (
            <button
              onClick={handleCreateInvite}
              className="text-xs bg-gray-700 hover:bg-gray-600 rounded px-3 py-1.5"
              title="Invite a new user"
            >
              + Invite
            </button>
          )}
          {currentUser && (
            <span className="text-xs text-gray-600 px-1" title={currentUser.pubKey.slice(0, 16)}>
              {currentUser.name ?? currentUser.pubKey.slice(0, 8) + '…'}
              {currentUser.role === 'owner' && <span className="ml-1 text-indigo-600">owner</span>}
            </span>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5"
            title="Settings"
          >
            ⚙
          </button>
          <button onClick={handleLogout} className="text-xs text-gray-500 hover:text-gray-300 ml-1" title="Lock session">
            🔒
          </button>
        </div>
      </header>

      {/* Search bar — always visible, collapses sections when active */}
      <div className="border-b border-gray-800 px-6 py-3">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search your library…"
          className="w-full max-w-lg bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500"
        />
      </div>

      {query ? (
        /* Search results: flat list */
        <div className="max-w-5xl mx-auto px-6 py-6">
          {loading ? (
            <div className="text-center text-gray-500 py-16">Searching…</div>
          ) : results.length === 0 ? (
            <div className="text-center text-gray-600 py-16">No results for "{query}"</div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {results.map(r => (
                <MediaCard key={r.id} result={r} onSelect={setSelected} />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Section view */
        <div className="py-6 space-y-8">
          {(sectionsLoading || sectionResultsLoading) ? (
            <div className="text-center text-gray-600 py-16 px-6">Loading…</div>
          ) : sections.length === 0 ? (
            <div className="text-center text-gray-600 py-16 px-6">
              No libraries yet. Use <strong>📂 Scan</strong> to import media, or go to Settings to create libraries.
            </div>
          ) : (() => {
            const rendered = sections
              .map(section => {
                const items = sectionResults.get(section.id) ?? []
                if (items.length === 0) return null
                return (
                  <LibrarySection
                    key={section.id}
                    section={section}
                    items={items}
                    onSelect={setSelected}
                  />
                )
              })
              .filter(Boolean)
            if (rendered.length === 0) {
              return (
                <div className="text-center text-gray-600 py-16 px-6">
                  No media yet. Use <strong>📂 Scan</strong> or <strong>🟠 Plex</strong> to import.
                </div>
              )
            }
            return rendered
          })()}
        </div>
      )}

      {selected && (
        <DetailPanel
          result={selected}
          onClose={() => setSelected(null)}
          onUnauthorized={handleUnauthorized}
          onWatchlistChange={loadSections}
        />
      )}
      {showAddMedia && (
        <AddMediaModal
          onClose={() => setShowAddMedia(false)}
          onAdded={() => { search(); loadSections() }}
          onUnauthorized={handleUnauthorized}
        />
      )}
      {showInvite && inviteToken && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6" onClick={() => setShowInvite(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-bold text-white mb-3">Invite Link</h2>
            <p className="text-xs text-gray-400 mb-3">Share this token with the person you want to invite. It expires in 7 days and can only be used once.</p>
            <div className="bg-gray-800 rounded-lg px-3 py-2 font-mono text-xs text-gray-200 break-all mb-4">{inviteToken}</div>
            <div className="flex gap-2">
              <button
                onClick={() => { navigator.clipboard.writeText(inviteToken); }}
                className="text-xs bg-indigo-600 hover:bg-indigo-500 rounded px-3 py-1.5"
              >
                Copy token
              </button>
              <button onClick={() => setShowInvite(false)} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MediaCard({ result, onSelect }: { result: MediaResult; onSelect: (r: MediaResult) => void }) {
  const available = result.sources.some(s => s.available)
  return (
    <button
      onClick={() => onSelect(result)}
      className="flex items-center gap-3 bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg px-3 py-2.5 text-left transition-colors w-full"
    >
      {result.poster_path ? (
        <img
          src={`${TMDB_IMG}${result.poster_path}`}
          alt=""
          className="w-8 h-12 object-cover rounded shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="w-8 h-12 bg-gray-800 rounded shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-white truncate">{result.title}</span>
          <span className="text-xs text-gray-500 shrink-0">{result.year}</span>
          <KindBadge kind={result.kind} />
        </div>
        {result.genres && result.genres.length > 0 && (
          <div className="text-xs text-gray-500 mt-0.5">{result.genres.join(', ')}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {result.watchlist && <WatchBadge status={result.watchlist.status} />}
        {result.bestSource && (
          <span className="text-xs bg-gray-700 rounded px-2 py-0.5 text-gray-300">
            {result.bestSource.encoding}
          </span>
        )}
        <span className={`text-xs rounded px-2 py-0.5 ${available ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'}`}>
          {result.sources.length} source{result.sources.length !== 1 ? 's' : ''}
        </span>
      </div>
    </button>
  )
}

function LibrarySection({ section, items, onSelect }: {
  section: SectionRecord
  items: MediaResult[]
  onSelect: (r: MediaResult) => void
}) {
  if (items.length === 0) return null
  return (
    <div>
      <div className="px-6 mb-3 flex items-baseline gap-3">
        <h2 className="text-base font-bold text-white">{section.name}</h2>
        <span className="text-xs text-gray-600">{items.length} title{items.length !== 1 ? 's' : ''}</span>
      </div>
      {section.view === 'row' ? (
        <div className="flex gap-3 overflow-x-auto px-6 pb-2 scrollbar-thin">
          {items.map(r => (
            <PosterCard key={r.id} result={r} onSelect={onSelect} />
          ))}
        </div>
      ) : (
        <div className="px-6 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {items.map(r => (
            <PosterCard key={r.id} result={r} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

const TMDB_IMG_W154 = 'https://image.tmdb.org/t/p/w154'

function PosterCard({ result, onSelect }: { result: MediaResult; onSelect: (r: MediaResult) => void }) {
  const available = result.sources.some(s => s.available)
  return (
    <button
      onClick={() => onSelect(result)}
      className="flex-shrink-0 w-28 group text-left"
    >
      <div className="relative rounded-lg overflow-hidden bg-gray-800 aspect-[2/3] mb-1.5">
        {result.poster_path ? (
          <img
            src={`${TMDB_IMG_W154}${result.poster_path}`}
            alt=""
            className="w-full h-full object-cover group-hover:opacity-80 transition-opacity"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs text-center px-2">
            {result.title}
          </div>
        )}
        {!available && (
          <div className="absolute inset-0 bg-black/50 flex items-end p-1">
            <span className="text-[10px] text-gray-400">Offline</span>
          </div>
        )}
        {result.watchlist?.status === 'watched' && (
          <div className="absolute top-1 right-1 w-4 h-4 bg-green-700 rounded-full flex items-center justify-center text-[10px]">✓</div>
        )}
        {result.watchlist?.status === 'watching' && (
          <div className="absolute top-1 right-1 w-4 h-4 bg-yellow-700 rounded-full flex items-center justify-center text-[10px]">▶</div>
        )}
      </div>
      <div className="text-xs text-gray-300 truncate leading-tight">{result.title}</div>
      <div className="text-[10px] text-gray-600 mt-0.5">{result.year}</div>
    </button>
  )
}

function DetailPanel({
  result, onClose, onUnauthorized, onWatchlistChange,
}: {
  result: MediaResult
  onClose: () => void
  onUnauthorized: () => void
  onWatchlistChange: () => void
}) {
  const [updatingStatus, setUpdatingStatus] = useState(false)

  async function handleStatusClick(status: WatchStatus) {
    setUpdatingStatus(true)
    try {
      await api.updateWatchlist(result.id, status)
      onWatchlistChange()
      onClose()
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized()
    } finally {
      setUpdatingStatus(false)
    }
  }

  const statuses: { value: WatchStatus; label: string }[] = [
    { value: 'unwatched', label: 'Unwatched' },
    { value: 'watching', label: 'Watching' },
    { value: 'watched', label: 'Watched' },
    { value: 'skipped', label: 'Skip' },
  ]

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-lg w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">{result.title}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-sm text-gray-400">{result.year}</span>
              <KindBadge kind={result.kind} />
              {result.watchlist && <WatchBadge status={result.watchlist.status} />}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        {result.genres && result.genres.length > 0 && (
          <p className="text-sm text-gray-400 mb-4">{result.genres.join(' · ')}</p>
        )}

        <div className="mb-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Watchlist</p>
          <div className="flex gap-2 flex-wrap">
            {statuses.map(s => {
              const active = result.watchlist?.status === s.value
              return (
                <button
                  key={s.value}
                  onClick={() => handleStatusClick(s.value)}
                  disabled={updatingStatus || active}
                  className={`text-xs rounded px-3 py-1.5 transition-colors disabled:cursor-default
                    ${active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                    }`}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>

        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Sources ({result.sources.length})
        </h3>
        <div className="space-y-2">
          {result.sources.map(s => (
            <div key={s.storageNodeId} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-400 truncate">{s.feedOwner.slice(0, 12)}…</div>
                <div className="text-xs text-gray-500">{(s.sizeBytes / 1e9).toFixed(1)} GB</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-300">{s.encoding}</span>
                {s.available ? (
                  <a href={`${BASE}${s.endpointUrl}`} target="_blank" rel="noreferrer"
                    className="text-xs bg-indigo-600 hover:bg-indigo-500 rounded px-2 py-1"
                    onClick={e => e.stopPropagation()}>
                    Play
                  </a>
                ) : (
                  <span className="text-xs text-gray-600">Offline</span>
                )}
              </div>
            </div>
          ))}
        </div>
        {result.imdb_id && (
          <a href={`https://www.imdb.com/title/${result.imdb_id}`} target="_blank" rel="noreferrer"
            className="inline-block mt-4 text-xs text-indigo-400 hover:text-indigo-300">
            View on IMDb →
          </a>
        )}
      </div>
    </div>
  )
}

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, string> = {
    movie: 'bg-blue-900 text-blue-300',
    series: 'bg-purple-900 text-purple-300',
    episode: 'bg-purple-900 text-purple-300',
    short: 'bg-gray-700 text-gray-300',
  }
  return <span className={`text-xs rounded px-1.5 py-0.5 ${colors[kind] ?? 'bg-gray-700 text-gray-300'}`}>{kind}</span>
}

function WatchBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    unwatched: 'bg-yellow-900 text-yellow-300',
    watching: 'bg-green-900 text-green-300',
    watched: 'bg-gray-700 text-gray-400',
    skipped: 'bg-gray-800 text-gray-600',
  }
  return <span className={`text-xs rounded px-1.5 py-0.5 ${styles[status] ?? ''}`}>{status}</span>
}
