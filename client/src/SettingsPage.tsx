import { useState, useEffect } from 'react'
import { api, UnauthorizedError, FACTORY_RESET_PHRASE } from './api'
import type {
  ProviderConfig, UserRecord, AuthConfig, LibraryRecord, SectionRecord, SectionFilter,
  FactoryResetPreview,
} from './api'

interface Props {
  onClose: () => void
  onUnauthorized: () => void
  userRole?: 'owner' | 'member'
}

export default function SettingsPage({ onClose, onUnauthorized, userRole }: Props) {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null)

  // Owner-only state
  const [users, setUsers] = useState<UserRecord[]>([])
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null)
  const [userMsg, setUserMsg] = useState<{ pubKey: string; text: string; ok: boolean } | null>(null)
  const [resetPw, setResetPw] = useState<Record<string, string>>({})
  const [configMsg, setConfigMsg] = useState<string | null>(null)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const isOwner = userRole === 'owner'

  // Libraries state
  const [libraries, setLibraries] = useState<LibraryRecord[]>([])
  const [newLibName, setNewLibName] = useState('')
  const [newLibColor, setNewLibColor] = useState('#6366f1')
  const [libMsg, setLibMsg] = useState<string | null>(null)
  const [editingLib, setEditingLib] = useState<string | null>(null)
  const [editLibName, setEditLibName] = useState('')
  const [editLibColor, setEditLibColor] = useState('')

  // Plex state
  const [plexUrl, setPlexUrl] = useState('')
  const [plexToken, setPlexToken] = useState('')
  const [plexEnabled, setPlexEnabled] = useState(false)
  const [plexMsg, setPlexMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [plexSaving, setPlexSaving] = useState(false)
  const [showPlexToken, setShowPlexToken] = useState(false)

  // Show/hide state for recovery password fields keyed by pubKey
  const [showRecoveryPw, setShowRecoveryPw] = useState<Record<string, boolean>>({})

  // Sections state
  const [sections, setSections] = useState<SectionRecord[]>([])
  const [newSecName, setNewSecName] = useState('')
  const [newSecView, setNewSecView] = useState<'row' | 'grid'>('row')
  const [newSecFilter, setNewSecFilter] = useState<SectionFilter>({})
  const [newSecSort, setNewSecSort] = useState<string>('')
  const [secMsg, setSecMsg] = useState<string | null>(null)

  const [resetPreview, setResetPreview] = useState<FactoryResetPreview | null>(null)
  const [resetPhrase, setResetPhrase] = useState('')
  const [resetAckIrreversible, setResetAckIrreversible] = useState(false)
  const [resetAckMembers, setResetAckMembers] = useState(false)
  const [resetAckPvfs, setResetAckPvfs] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetMsg, setResetMsg] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    api.getProviders()
      .then(list => {
        setProviders(list)
        const keys: Record<string, string> = {}
        const enab: Record<string, boolean> = {}
        for (const p of list) {
          keys[p.provider_id] = (p.config.read_access_token as string) ?? ''
          enab[p.provider_id] = p.enabled
          if (p.provider_id === 'plex') {
            setPlexUrl((p.config.server_url as string) ?? '')
            setPlexToken((p.config.token as string) ?? '')
            setPlexEnabled(p.enabled)
          }
        }
        setApiKeys(keys)
        setEnabled(enab)
      })
      .catch(err => { if (err instanceof UnauthorizedError) onUnauthorized() })
      .finally(() => setLoading(false))
  }, [])

  // Libraries and sections are per-user — load for everyone
  useEffect(() => {
    api.getLibraries()
      .then(r => setLibraries(r.libraries))
      .catch(() => {})
    api.getSections()
      .then(r => setSections(r.sections))
      .catch(() => {})
  }, [])

  // User management and server config are owner-only
  useEffect(() => {
    if (!isOwner) return
    api.listUsers()
      .then(r => setUsers(r.users))
      .catch(err => { if (err instanceof UnauthorizedError) onUnauthorized() })
    api.getAuthConfig()
      .then(setAuthConfig)
      .catch(() => {})
  }, [isOwner])

  async function handleRemoveUser(pubKey: string) {
    setUserMsg(null)
    try {
      await api.removeUser(pubKey)
      setUsers(prev => prev.filter(u => u.pubKey !== pubKey))
      setUserMsg({ pubKey, text: 'User removed.', ok: true })
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setUserMsg({ pubKey, text: err instanceof Error ? err.message : 'Error', ok: false })
    }
  }

  async function handleResetRecovery(pubKey: string) {
    const pw = resetPw[pubKey] ?? ''
    if (pw.length < 8) { setUserMsg({ pubKey, text: 'Password must be at least 8 characters.', ok: false }); return }
    setUserMsg(null)
    try {
      await api.resetUserRecovery(pubKey, pw)
      setResetPw(prev => ({ ...prev, [pubKey]: '' }))
      setUserMsg({ pubKey, text: 'Recovery password updated.', ok: true })
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setUserMsg({ pubKey, text: err instanceof Error ? err.message : 'Error', ok: false })
    }
  }

  async function handleToggleRegistration() {
    if (!authConfig) return
    const newMode = authConfig.registrationMode === 'open' ? 'closed' : 'open'
    try {
      const updated = await api.setAuthConfig({ registrationMode: newMode })
      setAuthConfig(updated)
      setConfigMsg(`Registration mode set to ${updated.registrationMode}.`)
      setTimeout(() => setConfigMsg(null), 3000)
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setConfigMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  async function handleCreateInvite() {
    try {
      const { token } = await api.createInvite()
      setInviteMsg(token)
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setInviteMsg('Error creating invite.')
    }
  }

  async function handleCreateLibrary() {
    if (!newLibName.trim()) return
    setLibMsg(null)
    try {
      const lib = await api.createLibrary({ name: newLibName.trim(), color: newLibColor })
      setLibraries(prev => [...prev, lib])
      setNewLibName('')
      setNewLibColor('#6366f1')
      setLibMsg('Library created.')
      setTimeout(() => setLibMsg(null), 2000)
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setLibMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  async function handleSaveLib(id: string) {
    setLibMsg(null)
    try {
      const updated = await api.updateLibrary(id, { name: editLibName, color: editLibColor })
      setLibraries(prev => prev.map(l => l.id === id ? updated : l))
      setEditingLib(null)
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setLibMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  async function handleDeleteLibrary(id: string) {
    setLibMsg(null)
    try {
      await api.deleteLibrary(id)
      setLibraries(prev => prev.filter(l => l.id !== id))
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setLibMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  async function handleCreateSection() {
    if (!newSecName.trim()) return
    setSecMsg(null)
    try {
      const sec = await api.createSection({
        name: newSecName.trim(),
        view: newSecView,
        filter: newSecFilter,
        sort: newSecSort || undefined,
      })
      setSections(prev => [...prev, sec])
      setNewSecName('')
      setNewSecView('row')
      setNewSecFilter({})
      setNewSecSort('')
      setSecMsg('Section created.')
      setTimeout(() => setSecMsg(null), 2000)
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setSecMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  async function handleDeleteSection(id: string) {
    setSecMsg(null)
    try {
      await api.deleteSection(id)
      setSections(prev => prev.filter(s => s.id !== id))
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setSecMsg(err instanceof Error ? err.message : 'Error')
    }
  }

  async function handleMoveSectionUp(idx: number) {
    if (idx === 0) return
    const reordered = [...sections]
    ;[reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]]
    setSections(reordered)
    await api.reorderSections(reordered.map(s => s.id)).catch(() => {})
  }

  async function handleMoveSectionDown(idx: number) {
    if (idx === sections.length - 1) return
    const reordered = [...sections]
    ;[reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]]
    setSections(reordered)
    await api.reorderSections(reordered.map(s => s.id)).catch(() => {})
  }

  async function savePlexProvider() {
    setPlexSaving(true)
    setPlexMsg(null)
    try {
      await api.upsertProvider('plex', {
        enabled: plexEnabled,
        name: 'Plex Media Server',
        server_url: plexUrl.trim(),
        token: plexToken.trim(),
      } as Parameters<typeof api.upsertProvider>[1])
      setPlexMsg({ text: 'Saved.', ok: true })
      setTimeout(() => setPlexMsg(null), 2000)
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setPlexMsg({ text: err instanceof Error ? err.message : 'Error', ok: false })
    } finally {
      setPlexSaving(false)
    }
  }

  async function saveProvider(providerId: string) {
    setSaving(providerId)
    setMsg(null)
    try {
      await api.upsertProvider(providerId, {
        read_access_token: apiKeys[providerId] ?? '',
        enabled: enabled[providerId] ?? false,
      })
      setMsg({ id: providerId, text: 'Saved.', ok: true })
      // Refresh to confirm server state.
      const list = await api.getProviders()
      setProviders(list)
      for (const p of list) {
        setApiKeys(prev => ({ ...prev, [p.provider_id]: (p.config.read_access_token as string) ?? '' }))
        setEnabled(prev => ({ ...prev, [p.provider_id]: p.enabled }))
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) { onUnauthorized(); return }
      setMsg({ id: providerId, text: err instanceof Error ? err.message : 'Error saving', ok: false })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-lg font-semibold text-white">Settings</h1>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">

        {/* Metadata Providers */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Metadata Providers
          </h2>

          {loading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : providers.length === 0 ? (
            <div className="text-sm text-gray-500">No providers configured.</div>
          ) : (
            <div className="space-y-4">
              {providers.filter(p => p.provider_id !== 'plex').map(p => (
                <ProviderCard
                  key={p.provider_id}
                  provider={p}
                  apiKey={apiKeys[p.provider_id] ?? ''}
                  isEnabled={enabled[p.provider_id] ?? false}
                  isSaving={saving === p.provider_id}
                  message={msg?.id === p.provider_id ? msg : null}
                  onApiKeyChange={v => setApiKeys(prev => ({ ...prev, [p.provider_id]: v }))}
                  onEnabledChange={v => setEnabled(prev => ({ ...prev, [p.provider_id]: v }))}
                  onSave={() => saveProvider(p.provider_id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Owner: Server Config */}
        {isOwner && authConfig && (
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Server Access
            </h2>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-white">Registration Mode</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {authConfig.registrationMode === 'open'
                      ? 'Open mode: anyone can create an account on this server. They only see what you share — never your config or private library.'
                      : 'Closed mode: new registrations require an invite token from you.'}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${authConfig.registrationMode === 'open' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'}`}>
                    {authConfig.registrationMode}
                  </span>
                  <div
                    onClick={handleToggleRegistration}
                    className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${authConfig.registrationMode === 'open' ? 'bg-indigo-600' : 'bg-gray-700'}`}
                  >
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${authConfig.registrationMode === 'open' ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-800 pt-4">
                <div className="text-sm font-medium text-white mb-2">Invite Token</div>
                <div className="text-xs text-gray-500 mb-2">Create a single-use invite link valid for 7 days.</div>
                <button
                  onClick={handleCreateInvite}
                  className="text-sm bg-gray-800 hover:bg-gray-700 rounded-lg px-4 py-2 transition-colors"
                >
                  Generate Invite
                </button>
                {inviteMsg && (
                  <div className="mt-2 p-2 bg-gray-800 rounded text-xs font-mono text-indigo-300 break-all">
                    {inviteMsg}
                  </div>
                )}
              </div>

              {configMsg && <p className="text-xs text-green-400">{configMsg}</p>}
            </div>
          </section>
        )}

        {/* Owner: User Management */}
        {isOwner && (
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Users
            </h2>
            <div className="space-y-3">
              {users.map(u => (
                <div key={u.pubKey} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{u.name ?? 'Unnamed user'}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${u.role === 'owner' ? 'bg-indigo-900 text-indigo-300' : 'bg-gray-800 text-gray-400'}`}>
                          {u.role}
                        </span>
                        {u.hasRecovery && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-900 text-green-400">recovery set</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-600 font-mono mt-0.5">{u.pubKey.slice(0, 20)}…</div>
                      <div className="text-xs text-gray-600 mt-0.5">
                        Joined {new Date(u.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    {u.role !== 'owner' && (
                      <button
                        onClick={() => handleRemoveUser(u.pubKey)}
                        className="text-xs text-red-500 hover:text-red-400 shrink-0 mt-0.5"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="border-t border-gray-800 pt-3 mt-1">
                      <div className="text-xs text-gray-500 mb-1.5">Set / reset recovery password</div>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <input
                            type={showRecoveryPw[u.pubKey] ? 'text' : 'password'}
                            value={resetPw[u.pubKey] ?? ''}
                            onChange={e => setResetPw(prev => ({ ...prev, [u.pubKey]: e.target.value }))}
                            placeholder="New recovery password (min 8 chars)"
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 pr-14 text-xs focus:outline-none focus:border-indigo-500"
                          />
                          {resetPw[u.pubKey] && (
                            <button
                              type="button"
                              onClick={() => setShowRecoveryPw(prev => ({ ...prev, [u.pubKey]: !prev[u.pubKey] }))}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300 px-1 py-0.5 rounded"
                            >
                              {showRecoveryPw[u.pubKey] ? 'Hide' : 'Show'}
                            </button>
                          )}
                        </div>
                        <button
                          onClick={() => handleResetRecovery(u.pubKey)}
                          disabled={!resetPw[u.pubKey] || (resetPw[u.pubKey]?.length ?? 0) < 8}
                          className="text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors shrink-0"
                        >
                          Set
                        </button>
                      </div>
                    </div>

                  {userMsg?.pubKey === u.pubKey && (
                    <p className={`text-xs mt-2 ${userMsg.ok ? 'text-green-400' : 'text-red-400'}`}>{userMsg.text}</p>
                  )}
                </div>
              ))}
              {users.length === 0 && (
                <div className="text-sm text-gray-500">No users registered.</div>
              )}
            </div>
          </section>
        )}

        {/* Owner: Libraries */}
        {isOwner && (
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Libraries
            </h2>
            <div className="space-y-2 mb-4">
              {libraries.map(lib => (
                <div key={lib.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  {editingLib === lib.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={editLibName}
                        onChange={e => setEditLibName(e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                      />
                      <input
                        type="color"
                        value={editLibColor}
                        onChange={e => setEditLibColor(e.target.value)}
                        className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                        title="Library color"
                      />
                      <button onClick={() => handleSaveLib(lib.id)} className="text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-1.5">Save</button>
                      <button onClick={() => setEditingLib(null)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1.5">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: lib.color ?? '#6366f1' }} />
                        <span className="text-sm text-white">{lib.name}</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setEditingLib(lib.id); setEditLibName(lib.name); setEditLibColor(lib.color ?? '#6366f1') }}
                          className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteLibrary(lib.id)}
                          className="text-xs text-red-500 hover:text-red-400 px-2 py-1"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {libraries.length === 0 && (
                <div className="text-sm text-gray-500">No libraries yet.</div>
              )}
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="text-xs text-gray-400 mb-3 font-medium">New Library</div>
              <div className="flex gap-2">
                <input
                  value={newLibName}
                  onChange={e => setNewLibName(e.target.value)}
                  placeholder="Library name (e.g. Movies, TV Shows)"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  onKeyDown={e => e.key === 'Enter' && handleCreateLibrary()}
                />
                <input
                  type="color"
                  value={newLibColor}
                  onChange={e => setNewLibColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  title="Library color"
                />
                <button
                  onClick={handleCreateLibrary}
                  disabled={!newLibName.trim()}
                  className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg px-3 py-1.5 shrink-0"
                >
                  Create
                </button>
              </div>
              {libMsg && <p className="text-xs mt-2 text-green-400">{libMsg}</p>}
            </div>
          </section>
        )}

        {/* Home Sections — per user, everyone can customize */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Home Sections
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Sections appear on your home page in order. Each section filters by library, genre, kind, or watch status. Row view shows a horizontal scroll strip; grid view shows a poster grid.
          </p>

            <div className="space-y-2 mb-4">
              {sections.map((sec, idx) => (
                <div key={sec.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3">
                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => handleMoveSectionUp(idx)} disabled={idx === 0} className="text-xs text-gray-600 hover:text-gray-300 disabled:opacity-30">▲</button>
                    <button onClick={() => handleMoveSectionDown(idx)} disabled={idx === sections.length - 1} className="text-xs text-gray-600 hover:text-gray-300 disabled:opacity-30">▼</button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white truncate">{sec.name}</span>
                      <span className="text-xs bg-gray-800 text-gray-400 rounded px-1.5 py-0.5">{sec.view}</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      {[
                        sec.filter.library && `library: ${sec.filter.library}`,
                        sec.filter.genre && `genre: ${sec.filter.genre}`,
                        sec.filter.kind && `kind: ${sec.filter.kind}`,
                        sec.filter.watchStatus && `status: ${sec.filter.watchStatus}`,
                        sec.filter.available && 'available only',
                      ].filter(Boolean).join(' · ') || 'No filters (shows all)'}
                    </div>
                  </div>
                  <button onClick={() => handleDeleteSection(sec.id)} className="text-xs text-red-500 hover:text-red-400 shrink-0">Delete</button>
                </div>
              ))}
              {sections.length === 0 && (
                <div className="text-sm text-gray-500">No sections yet. Create one below.</div>
              )}
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
              <div className="text-xs text-gray-400 font-medium">New Section</div>
              <div className="flex gap-2">
                <input
                  value={newSecName}
                  onChange={e => setNewSecName(e.target.value)}
                  placeholder="Section title (e.g. Movies, Continue Watching)"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                />
                <select
                  value={newSecView}
                  onChange={e => setNewSecView(e.target.value as 'row' | 'grid')}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                >
                  <option value="row">Row</option>
                  <option value="grid">Grid</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Library filter</label>
                  <select
                    value={newSecFilter.library ?? ''}
                    onChange={e => setNewSecFilter(f => ({ ...f, library: e.target.value || undefined }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">Any library</option>
                    {libraries.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Kind filter</label>
                  <select
                    value={newSecFilter.kind ?? ''}
                    onChange={e => setNewSecFilter(f => ({ ...f, kind: e.target.value || undefined }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">Any kind</option>
                    <option value="movie">Movies</option>
                    <option value="series">Series</option>
                    <option value="episode">Episodes</option>
                    <option value="short">Shorts</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Watch status filter</label>
                  <select
                    value={newSecFilter.watchStatus ?? ''}
                    onChange={e => setNewSecFilter(f => ({ ...f, watchStatus: e.target.value || undefined }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">Any status</option>
                    <option value="unwatched">Unwatched</option>
                    <option value="watching">Watching</option>
                    <option value="watched">Watched</option>
                    <option value="skipped">Skipped</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Sort</label>
                  <select
                    value={newSecSort}
                    onChange={e => setNewSecSort(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">Default</option>
                    <option value="title">Title A–Z</option>
                    <option value="year">Year (newest first)</option>
                    <option value="addedAt">Recently added</option>
                  </select>
                </div>
              </div>
              <button
                onClick={handleCreateSection}
                disabled={!newSecName.trim()}
                className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg px-4 py-2"
              >
                Add Section
              </button>
              {secMsg && <p className="text-xs text-green-400">{secMsg}</p>}
            </div>
          </section>

        {/* Plex */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Plex Media Server
          </h2>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <p className="text-xs text-gray-500">
              Connect your Plex server to import your library and sync watch status. After saving, use the <strong>Plex Sync</strong> button in the main toolbar.
            </p>
            <div className="space-y-2">
              <label className="block text-xs text-gray-400">Server URL</label>
              <input
                value={plexUrl}
                onChange={e => setPlexUrl(e.target.value)}
                placeholder="http://192.168.1.100:32400"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs text-gray-400">
                Plex Token
                <a
                  href="https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/"
                  target="_blank" rel="noreferrer"
                  className="ml-2 text-indigo-400 hover:text-indigo-300"
                >
                  How to find your token →
                </a>
              </label>
              <div className="relative">
                <input
                  type={showPlexToken ? 'text' : 'password'}
                  value={plexToken}
                  onChange={e => setPlexToken(e.target.value)}
                  placeholder="xxxxxxxxxxxxxxxxxxxx"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 pr-16 text-sm focus:outline-none focus:border-indigo-500 font-mono"
                />
                {plexToken && (
                  <button
                    type="button"
                    onClick={() => setShowPlexToken(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded"
                  >
                    {showPlexToken ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-400">
                <div
                  onClick={() => setPlexEnabled(v => !v)}
                  className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${plexEnabled ? 'bg-indigo-600' : 'bg-gray-700'}`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${plexEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
                Enabled
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={savePlexProvider}
                disabled={plexSaving}
                className="text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2"
              >
                {plexSaving ? 'Saving…' : 'Save'}
              </button>
              {plexMsg && (
                <span className={`text-xs ${plexMsg.ok ? 'text-green-400' : 'text-red-400'}`}>{plexMsg.text}</span>
              )}
            </div>
          </div>
        </section>

        {/* Owner: factory reset */}
        {isOwner && (
          <section className="border border-red-900/60 rounded-xl p-5 bg-red-950/30">
            <h2 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-2">
              Factory reset (entire server)
            </h2>
            <p className="text-xs text-red-200/80 mb-3 leading-relaxed">
              Permanently deletes the shared catalog, all member accounts, invites, staged imports,
              libraries, per-user settings, followed feeds, and PhraseVault file registrations
              (metadata only). Your owner login remains. This cannot be undone.
            </p>
            <p className="text-xs text-emerald-300/90 mb-4 leading-relaxed border border-emerald-900/50 rounded-lg px-3 py-2 bg-emerald-950/30">
              Does <strong className="text-emerald-200">not</strong> delete your media library files from
              disk or NAS (<code className="font-mono text-emerald-200/80">file://</code> paths stay on
              the filesystem). You can scan and import again afterward. Only copies stored inside
              PhraseVault&apos;s PVFS data directory are removed.
            </p>
            {!resetPreview ? (
              <button
                type="button"
                onClick={() => {
                  api.factoryResetPreview()
                    .then(setResetPreview)
                    .catch(err => {
                      if (err instanceof UnauthorizedError) onUnauthorized()
                      else setResetMsg({ text: String(err), ok: false })
                    })
                }}
                className="text-sm border border-red-700 text-red-300 hover:bg-red-900/40 rounded-lg px-4 py-2"
              >
                Load impact preview…
              </button>
            ) : (
              <div className="space-y-3 text-xs text-gray-300 mb-4">
                <p className="text-red-300">{resetPreview.warning}</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>{resetPreview.hypercore_nodes} catalog nodes</li>
                  <li>{resetPreview.member_accounts} member accounts</li>
                  <li>{resetPreview.invites_pending} pending invites</li>
                  <li>{resetPreview.staged_import_batches} staged import batches</li>
                  <li>{resetPreview.followed_feeds} followed feeds</li>
                  <li>{resetPreview.libraries_defined} library definitions</li>
                </ul>
              </div>
            )}
            <label className="block text-xs text-gray-400 mb-1">
              Type <span className="font-mono text-red-300">{FACTORY_RESET_PHRASE}</span> to confirm
            </label>
            <input
              value={resetPhrase}
              onChange={e => setResetPhrase(e.target.value)}
              className="w-full bg-gray-900 border border-red-800 rounded-lg px-3 py-2 text-sm font-mono mb-3 focus:outline-none focus:border-red-500"
              placeholder={FACTORY_RESET_PHRASE}
            />
            <div className="space-y-2 mb-4">
              {[
                [resetAckIrreversible, setResetAckIrreversible, 'I understand this is irreversible'],
                [resetAckMembers, setResetAckMembers, 'Delete all member accounts and invites'],
                [resetAckPvfs, setResetAckPvfs, 'Clear PhraseVault registrations and PVFS store (not library files on disk)'],
              ].map(([checked, setChecked, label]) => (
                <label key={String(label)} className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked as boolean}
                    onChange={e => (setChecked as (v: boolean) => void)(e.target.checked)}
                    className="rounded border-gray-600"
                  />
                  {label as string}
                </label>
              ))}
            </div>
            <button
              type="button"
              disabled={
                resetBusy
                || resetPhrase !== FACTORY_RESET_PHRASE
                || !resetAckIrreversible
                || !resetAckMembers
                || !resetAckPvfs
              }
              onClick={async () => {
                if (!window.confirm(
                  'Last chance: wipe all server catalog data and user accounts? '
                  + 'Your video files on disk/NAS will NOT be deleted.',
                )) return
                setResetBusy(true)
                setResetMsg(null)
                try {
                  await api.factoryReset({
                    confirmation_phrase: resetPhrase,
                    acknowledge_irreversible: true,
                    acknowledge_remove_all_members: true,
                    acknowledge_remove_pvfs_inventory: true,
                  })
                  setResetMsg({ text: 'Factory reset complete. Reload the app.', ok: true })
                  setResetPhrase('')
                  setResetAckIrreversible(false)
                  setResetAckMembers(false)
                  setResetAckPvfs(false)
                } catch (err) {
                  if (err instanceof UnauthorizedError) onUnauthorized()
                  else setResetMsg({ text: err instanceof Error ? err.message : 'Reset failed', ok: false })
                } finally {
                  setResetBusy(false)
                }
              }}
              className="text-sm bg-red-800 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg px-4 py-2 font-medium"
            >
              {resetBusy ? 'Resetting…' : 'Factory reset server'}
            </button>
            {resetMsg && (
              <p className={`text-xs mt-3 ${resetMsg.ok ? 'text-green-400' : 'text-red-400'}`}>{resetMsg.text}</p>
            )}
          </section>
        )}

        {/* Forest info */}
        <section>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Truth Forest
          </h2>
          <p className="text-sm text-gray-500 leading-relaxed">
            MediaForest stores all library data as a signed, content-addressed directed
            acyclic graph. Each node is identified by its BLAKE3 hash — immutable history
            is preserved, changes are recorded as new nodes. Configuration, media metadata,
            file identities, and watchlist state all live in the forest.
          </p>
        </section>

      </div>
    </div>
  )
}

function ProviderCard({
  provider, apiKey, isEnabled, isSaving, message,
  onApiKeyChange, onEnabledChange, onSave,
}: {
  provider: ProviderConfig
  apiKey: string
  isEnabled: boolean
  isSaving: boolean
  message: { text: string; ok: boolean } | null
  onApiKeyChange: (v: string) => void
  onEnabledChange: (v: boolean) => void
  onSave: () => void
}) {
  const [showToken, setShowToken] = useState(false)
  const providerMeta: Record<string, { description: string; docsUrl: string }> = {
    tmdb: {
      description: 'Movie & TV metadata, posters, and external IDs.',
      docsUrl: 'https://www.themoviedb.org/settings/api',
    },
  }
  const meta = providerMeta[provider.provider_id]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-white">{provider.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${isEnabled ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'}`}>
              {isEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          {meta && <p className="text-xs text-gray-500 mt-0.5">{meta.description}</p>}
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-gray-400">Enable</span>
          <div
            onClick={() => onEnabledChange(!isEnabled)}
            className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${isEnabled ? 'bg-indigo-600' : 'bg-gray-700'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </div>
        </label>
      </div>

      <div className="space-y-2">
        <label className="block text-xs text-gray-400">
          Read Access Token
          {meta && (
            <a href={meta.docsUrl} target="_blank" rel="noreferrer"
              className="ml-2 text-indigo-400 hover:text-indigo-300">
              Get a free token →
            </a>
          )}
        </label>
        <div className="relative">
          <input
            type={showToken ? 'text' : 'password'}
            value={apiKey}
            onChange={e => onApiKeyChange(e.target.value)}
            placeholder="Paste your Read Access Token…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 pr-16 text-sm focus:outline-none focus:border-indigo-500 font-mono"
          />
          {apiKey && (
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded"
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={onSave}
          disabled={isSaving}
          className="text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2 transition-colors"
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
        {message && (
          <span className={`text-xs ${message.ok ? 'text-green-400' : 'text-red-400'}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
