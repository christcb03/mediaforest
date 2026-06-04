import { useState, useEffect, useCallback } from 'react'
import { api, BASE, TOKEN_KEY, UnauthorizedError } from './api'
import type { MediaResult, HealthResponse, WatchStatus, LoginResponse } from './api'

const TMDB_IMG = 'https://image.tmdb.org/t/p/w92'
import LoginPage from './LoginPage'
import AddMediaModal from './AddMediaModal'
import SettingsPage from './SettingsPage'
import ScanPage from './ScanPage'

const USER_KEY = 'pv_user'

export default function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))
  const [currentUser, setCurrentUser] = useState<{ pubKey: string; role: string; name: string | null } | null>(
    () => { try { return JSON.parse(sessionStorage.getItem(USER_KEY) ?? 'null') } catch { return null } }
  )
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [availableOnly, setAvailableOnly] = useState(false)
  const [results, setResults] = useState<MediaResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<MediaResult | null>(null)
  const [followKey, setFollowKey] = useState('')
  const [followMsg, setFollowMsg] = useState('')
  const [showAddMedia, setShowAddMedia] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showScan, setShowScan] = useState(false)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [showInvite, setShowInvite] = useState(false)

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

  const search = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const res = await api.search({ q: query || undefined, kind: kind || undefined, available: availableOnly || undefined })
      setResults(res.results)
    } catch (err) {
      if (err instanceof UnauthorizedError) handleUnauthorized()
    } finally {
      setLoading(false)
    }
  }, [token, query, kind, availableOnly])

  useEffect(() => { search() }, [search])

  if (!token) return <LoginPage onLogin={handleLogin} />
  if (showSettings) return (
    <SettingsPage onClose={() => setShowSettings(false)} onUnauthorized={handleUnauthorized} userRole={currentUser?.role as 'owner' | 'member' | undefined} />
  )
  if (showScan) return (
    <ScanPage onClose={() => setShowScan(false)} onUnauthorized={handleUnauthorized} />
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

      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex gap-3 mb-6">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search your library…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
          />
          <select
            value={kind}
            onChange={e => setKind(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none"
          >
            <option value="">All types</option>
            <option value="movie">Movies</option>
            <option value="series">Series</option>
            <option value="episode">Episodes</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={availableOnly}
              onChange={e => setAvailableOnly(e.target.checked)}
              className="accent-indigo-500"
            />
            Available only
          </label>
        </div>

        {loading ? (
          <div className="text-center text-gray-500 py-16">Loading…</div>
        ) : results.length === 0 ? (
          <div className="text-center text-gray-600 py-16">
            No titles yet. Follow a friend or add media to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {results.map(r => (
              <MediaCard key={r.id} result={r} onSelect={setSelected} />
            ))}
          </div>
        )}
      </div>

      {selected && (
        <DetailPanel
          result={selected}
          onClose={() => setSelected(null)}
          onUnauthorized={handleUnauthorized}
          onWatchlistChange={search}
        />
      )}
      {showAddMedia && (
        <AddMediaModal
          onClose={() => setShowAddMedia(false)}
          onAdded={search}
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
