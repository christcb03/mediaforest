import { useState, useEffect } from 'react'
import { api, UnauthorizedError } from './api'
import type { PlexSection, LibraryRecord } from './api'

interface Props {
  onClose: () => void
  onUnauthorized: () => void
  onImportDone: () => void
}

export default function PlexSyncPage({ onClose, onUnauthorized, onImportDone }: Props) {
  const [status, setStatus] = useState<'checking' | 'connected' | 'error'>('checking')
  const [statusMsg, setStatusMsg] = useState('')
  const [sections, setSections] = useState<PlexSection[]>([])
  const [libraries, setLibraries] = useState<LibraryRecord[]>([])
  const [importing, setImporting] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [results, setResults] = useState<Record<string, { imported: number; watchSynced: number; skipped: number; failed: number }>>({})
  const [syncResult, setSyncResult] = useState<{ updated: number; skipped: number } | null>(null)
  const [selectedLib, setSelectedLib] = useState<Record<string, string>>({})
  const [syncWatch, setSyncWatch] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api.plexStatus()
      .then(r => {
        setStatus('connected')
        setStatusMsg(`Plex ${r.version}`)
        return api.plexLibraries()
      })
      .then(r => setSections(r.sections))
      .catch(err => {
        if (err instanceof UnauthorizedError) { onUnauthorized(); return }
        setStatus('error')
        setStatusMsg(err instanceof Error ? err.message : 'Could not connect to Plex')
      })

    api.getLibraries()
      .then(r => setLibraries(r.libraries))
      .catch(() => {})
  }, [])

  async function handleImport(section: PlexSection) {
    setImporting(section.key)
    try {
      const result = await api.plexImport({
        sectionKey: section.key,
        library: selectedLib[section.key] || undefined,
        syncWatchStatus: syncWatch[section.key] ?? true,
      })
      setResults(prev => ({ ...prev, [section.key]: result }))
      onImportDone()
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setResults(prev => ({
        ...prev,
        [section.key]: { imported: 0, watchSynced: 0, skipped: 0, failed: -1 },
      }))
    } finally {
      setImporting(null)
    }
  }

  async function handleSyncWatch() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const r = await api.plexSyncWatch()
      setSyncResult(r)
      onImportDone()
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">← Back</button>
        <h1 className="text-lg font-semibold text-white">Plex Sync</h1>
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${
            status === 'connected' ? 'bg-green-900 text-green-300' :
            status === 'error' ? 'bg-red-900 text-red-300' :
            'bg-gray-800 text-gray-400'
          }`}>
            {status === 'checking' ? 'Connecting…' : statusMsg}
          </span>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">

        {status === 'error' && (
          <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-sm text-red-300">
            Cannot reach Plex server. Make sure the server URL and token are configured in Settings → Metadata Providers.
          </div>
        )}

        {status === 'connected' && (
          <>
            {/* Library import */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Plex Libraries
              </h2>
              <p className="text-xs text-gray-500 mb-4">
                Import a Plex library section into MediaForest. Existing items are skipped (deduped by TMDB ID). Watch status is synced by default.
              </p>
              <div className="space-y-3">
                {sections.map(sec => {
                  const r = results[sec.key]
                  const isImporting = importing === sec.key
                  return (
                    <div key={sec.key} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-white">{sec.title}</span>
                            <span className="text-xs bg-gray-800 text-gray-400 rounded px-1.5 py-0.5">{sec.type}</span>
                            <span className="text-xs text-gray-500">{sec.count} items</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <select
                          value={selectedLib[sec.key] ?? ''}
                          onChange={e => setSelectedLib(prev => ({ ...prev, [sec.key]: e.target.value }))}
                          disabled={isImporting}
                          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                        >
                          <option value="">No library</option>
                          {libraries.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={syncWatch[sec.key] ?? true}
                            onChange={e => setSyncWatch(prev => ({ ...prev, [sec.key]: e.target.checked }))}
                            disabled={isImporting}
                            className="accent-indigo-500"
                          />
                          Sync watch status
                        </label>
                        <button
                          onClick={() => handleImport(sec)}
                          disabled={!!importing}
                          className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg px-4 py-1.5 ml-auto"
                        >
                          {isImporting ? 'Importing…' : 'Import'}
                        </button>
                      </div>
                      {r && (
                        <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${r.failed === -1 ? 'bg-red-950 text-red-300' : 'bg-gray-800 text-gray-300'}`}>
                          {r.failed === -1 ? 'Import failed — check server logs.' : (
                            <>
                              {r.imported > 0 && <span className="text-green-400 mr-2">+{r.imported} imported</span>}
                              {r.watchSynced > 0 && <span className="text-blue-400 mr-2">{r.watchSynced} watch-synced</span>}
                              {r.skipped > 0 && <span className="text-gray-500 mr-2">{r.skipped} skipped</span>}
                              {r.failed > 0 && <span className="text-red-400">{r.failed} failed</span>}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
                {sections.length === 0 && status === 'connected' && (
                  <div className="text-sm text-gray-500">No movie or TV libraries found in Plex.</div>
                )}
              </div>
            </section>

            {/* Watch status sync */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Sync Watch Status
              </h2>
              <p className="text-xs text-gray-500 mb-4">
                Pull the latest watch state from Plex for all previously imported items. Useful after watching something in Plex.
              </p>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <button
                  onClick={handleSyncWatch}
                  disabled={syncing}
                  className="text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded-lg px-4 py-2"
                >
                  {syncing ? 'Syncing…' : 'Sync Now'}
                </button>
                {syncResult && (
                  <div className="mt-3 text-xs text-gray-300">
                    {syncResult.updated > 0
                      ? <span className="text-green-400">{syncResult.updated} updated</span>
                      : <span className="text-gray-500">Nothing to update</span>
                    }
                    {syncResult.skipped > 0 && <span className="text-gray-500 ml-2">{syncResult.skipped} unchanged</span>}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

      </div>
    </div>
  )
}
