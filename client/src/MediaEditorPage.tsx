import { useState, useEffect, useCallback } from 'react'
import { api, UnauthorizedError } from './api'
import type { MediaResult } from './api'

// Simple client-side list from user's personalized search results. No server pagination needed for typical libraries.

interface Props {
  onClose: () => void
  onUnauthorized: () => void
  initialMediaId?: string
}

interface MediaPayload {
  title: string
  year: number
  kind: 'movie' | 'series' | 'episode' | 'short'
  tmdb_id?: string
  imdb_id?: string
  tvdb_id?: string
  season?: number
  episode?: number
  duration_ms?: number
  genres?: string[]
  poster_path?: string
  library?: string
  tags?: string[]
}

export default function MediaEditorPage({ onClose, onUnauthorized, initialMediaId }: Props) {
  const [results, setResults] = useState<MediaResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [editing, setEditing] = useState<MediaResult | null>(null)
  const [form, setForm] = useState<Partial<MediaPayload>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [hasAutoOpened, setHasAutoOpened] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  const loadResults = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.search({ q: debouncedQuery || undefined })
      // search returns the user's personalized results (titles they have access to via their data)
      setResults(res.results)
      setTotal(res.count || res.results.length)
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized()
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, onUnauthorized])

  useEffect(() => { loadResults() }, [loadResults])

  // Auto-open the editor form for a specific title when opened from a detail card
  useEffect(() => {
    if (initialMediaId && results.length > 0 && !hasAutoOpened && !editing) {
      const target = results.find(r => r.id === initialMediaId)
      if (target) {
        openEditor(target)
        setHasAutoOpened(true)
      }
    }
  }, [initialMediaId, results, hasAutoOpened, editing])

  useEffect(() => {
    setHasAutoOpened(false)
  }, [initialMediaId])

  function handleQuery(v: string) {
    setQuery(v)
  }

  function openEditor(result: MediaResult) {
    setEditing(result)
    // Prefill form from the current result's data (user's view of the title)
    setForm({
      title: result.title,
      year: result.year,
      kind: result.kind,
      genres: result.genres,
      imdb_id: result.imdb_id,
      poster_path: result.poster_path || undefined,
      library: result.library,
      tags: result.tags,
      // tmdb etc may be in bestSource or not directly on result; user can fill
      tmdb_id: (result as any).tmdb_id,
    })
    setSaveMsg('')
  }

  function closeEditor() {
    setEditing(null)
    setForm({})
    setSaveMsg('')
  }

  function updateForm<K extends keyof MediaPayload>(key: K, value: MediaPayload[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function updateArrayField(key: 'genres' | 'tags', value: string) {
    const arr = value.split(',').map(s => s.trim()).filter(Boolean)
    setForm(prev => ({ ...prev, [key]: arr }))
  }

  async function handleSave() {
    if (!editing) return
    setSaving(true)
    setSaveMsg('')
    try {
      // Build a payload from edits + fallbacks from current result
      const updatedPayload = {
        title: form.title || editing.title,
        year: form.year ?? editing.year,
        kind: form.kind || editing.kind,
        genres: form.genres || editing.genres,
        imdb_id: form.imdb_id || editing.imdb_id,
        poster_path: form.poster_path || editing.poster_path,
        library: form.library || editing.library,
        tags: form.tags || editing.tags,
        tmdb_id: form.tmdb_id,
        tvdb_id: form.tvdb_id,
        duration_ms: form.duration_ms,
        season: form.season,
        episode: form.episode,
      }
      const res = await api.replaceMedia({
        old_media_id: editing.id,
        payload: updatedPayload,
      })
      setSaveMsg(`Updated for you! New media id ${res.new_media_id.slice(0,8)}… (migrated ${res.migrated_storages} of your sources, ${res.migrated_watchlists} watchlists). Your library view now uses the updated details.`)
      // refresh list after short delay
      setTimeout(() => {
        loadResults()
        closeEditor()
      }, 1200)
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized()
      else setSaveMsg('Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">←</button>
        <h1 className="text-lg font-bold text-white">✏️ Title Editor</h1>
        <span className="text-xs text-gray-600">edit metadata for titles in *your* library (per-user; only your crosslinks/storages/watchlists are updated)</span>
        <button
          onClick={loadResults}
          className="ml-auto text-xs bg-gray-800 hover:bg-gray-700 rounded px-3 py-1.5"
          disabled={loading}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-4">
        <div className="flex gap-3 mb-4">
          <input
            value={query}
            onChange={e => handleQuery(e.target.value)}
            placeholder="Search titles in your library…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-4 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
          <div className="text-xs text-gray-500 self-center">{total} titles</div>
        </div>

        {loading && results.length === 0 && <div className="text-center py-12 text-gray-500">Loading your titles…</div>}

        <div className="space-y-2">
          {results.map(result => (
            <div key={result.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white truncate">{result.title} {result.year ? `(${result.year})` : ''}</div>
                <div className="text-xs text-gray-400 flex gap-2 mt-0.5">
                  <span>{result.kind}</span>
                  {result.genres?.length ? <span>· {result.genres.join(', ')}</span> : null}
                  {result.bestSource && <span>· {result.bestSource.encoding}</span>}
                  {result.library && <span>· {result.library}</span>}
                  {result.watchlist && <span>· watch: {result.watchlist.status}</span>}
                </div>
                <div className="text-[10px] text-gray-600 font-mono mt-1 truncate">{result.id}</div>
              </div>
              <button
                onClick={() => openEditor(result)}
                className="text-xs bg-indigo-700 hover:bg-indigo-600 rounded px-3 py-1.5"
              >
                Edit
              </button>
            </div>
          ))}
          {results.length === 0 && !loading && (
            <div className="text-center py-12 text-gray-500">No titles in your library yet. Use Scan or Add Media to import some.</div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6" onClick={closeEditor}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <div>
                <h2 className="text-base font-semibold">Edit Title</h2>
                <div className="text-xs text-gray-500 font-mono">{editing.id}</div>
              </div>
              <button onClick={closeEditor} className="text-gray-400 hover:text-white text-xl">×</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs text-gray-400">Title</span>
                  <input value={form.title || ''} onChange={e => updateForm('title', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">Year</span>
                  <input type="number" value={form.year || ''} onChange={e => updateForm('year', parseInt(e.target.value) || 0)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">Kind</span>
                  <select value={form.kind || 'movie'} onChange={e => updateForm('kind', e.target.value as any)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm">
                    <option value="movie">movie</option>
                    <option value="series">series</option>
                    <option value="episode">episode</option>
                    <option value="short">short</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">Library</span>
                  <input value={form.library || ''} onChange={e => updateForm('library', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">TMDB ID</span>
                  <input value={form.tmdb_id || ''} onChange={e => updateForm('tmdb_id', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">IMDb ID</span>
                  <input value={form.imdb_id || ''} onChange={e => updateForm('imdb_id', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">TVDB ID</span>
                  <input value={form.tvdb_id || ''} onChange={e => updateForm('tvdb_id', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">Poster Path</span>
                  <input value={form.poster_path || ''} onChange={e => updateForm('poster_path', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400">Duration (ms)</span>
                  <input type="number" value={form.duration_ms || ''} onChange={e => updateForm('duration_ms', parseInt(e.target.value) || undefined)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                {(form.kind === 'series' || form.kind === 'episode') && (
                  <>
                    <label className="block">
                      <span className="text-xs text-gray-400">Season</span>
                      <input type="number" value={form.season || ''} onChange={e => updateForm('season', parseInt(e.target.value) || undefined)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-400">Episode</span>
                      <input type="number" value={form.episode || ''} onChange={e => updateForm('episode', parseInt(e.target.value) || undefined)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                    </label>
                  </>
                )}
                <label className="block sm:col-span-2">
                  <span className="text-xs text-gray-400">Genres (comma separated)</span>
                  <input value={(form.genres || []).join(', ')} onChange={e => updateArrayField('genres', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs text-gray-400">Tags (comma separated)</span>
                  <input value={(form.tags || []).join(', ')} onChange={e => updateArrayField('tags', e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm" />
                </label>
              </div>

              {saveMsg && <div className="text-sm text-green-400 bg-green-950/50 border border-green-900 rounded p-2">{saveMsg}</div>}

              <div className="flex gap-3 pt-2">
                <button onClick={closeEditor} disabled={saving} className="flex-1 text-sm bg-gray-800 hover:bg-gray-700 rounded px-4 py-2">Cancel</button>
                <button onClick={handleSave} disabled={saving} className="flex-1 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2">
                  {saving ? 'Saving…' : 'Save & Create Updated Title'}
                </button>
              </div>
              <div className="text-[10px] text-gray-600">This will create a new media node with the updated details and automatically migrate your storage sources and watchlist entries to it. The old node remains for history.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
