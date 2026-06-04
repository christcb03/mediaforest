import { useState, useEffect } from 'react'
import { api, UnauthorizedError } from './api'
import type { ProviderConfig, UserRecord, AuthConfig } from './api'

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

  useEffect(() => {
    api.getProviders()
      .then(list => {
        setProviders(list)
        const keys: Record<string, string> = {}
        const enab: Record<string, boolean> = {}
        for (const p of list) {
          keys[p.provider_id] = (p.config.read_access_token as string) ?? ''
          enab[p.provider_id] = p.enabled
        }
        setApiKeys(keys)
        setEnabled(enab)
      })
      .catch(err => { if (err instanceof UnauthorizedError) onUnauthorized() })
      .finally(() => setLoading(false))
  }, [])

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
              {providers.map(p => (
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
                      ? 'Anyone can register — no invite required.'
                      : 'Registration requires an invite token from you.'}
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

                  {u.role !== 'owner' && (
                    <div className="border-t border-gray-800 pt-3 mt-1">
                      <div className="text-xs text-gray-500 mb-1.5">Set / reset recovery password</div>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={resetPw[u.pubKey] ?? ''}
                          onChange={e => setResetPw(prev => ({ ...prev, [u.pubKey]: e.target.value }))}
                          placeholder="New recovery password (min 8 chars)"
                          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                        />
                        <button
                          onClick={() => handleResetRecovery(u.pubKey)}
                          disabled={!resetPw[u.pubKey] || (resetPw[u.pubKey]?.length ?? 0) < 8}
                          className="text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors shrink-0"
                        >
                          Set
                        </button>
                      </div>
                    </div>
                  )}

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
