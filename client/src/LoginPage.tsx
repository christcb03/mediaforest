import { useState, useEffect } from 'react'
import { signChallenge, deriveAuthPubKey } from './crypto'
import { api } from './api'
import type { LoginResponse } from './api'

const AGENT_TIMEOUT_MS = 2000

// Try localhost first; fall back to host.docker.internal for Docker-hosted browsers
async function probeAgentUrl(): Promise<string | null> {
  for (const base of ['http://localhost:8765', 'http://host.docker.internal:8765']) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS)
      const res = await fetch(`${base}/health`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) {
        const { ok } = await res.json()
        if (ok) return base
      }
    } catch { /* try next */ }
  }
  return null
}

const AGENT_URL = 'http://localhost:8765'

interface Props {
  onLogin: (resp: LoginResponse) => void
}

type AgentState = 'probing' | 'signing' | 'available' | 'unavailable'
type Mode = 'login' | 'register' | 'recovery' | 'password'
type RegisterAgentState = 'idle' | 'probing' | 'ready' | 'unavailable'

export default function LoginPage({ onLogin }: Props) {
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [agentState, setAgentState] = useState<AgentState>('probing')
  const [registerAgentState, setRegisterAgentState] = useState<RegisterAgentState>('idle')
  const [agentPubKey, setAgentPubKey] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string>(AGENT_URL)
  const [mode, setMode] = useState<Mode>('login')
  const [hasOwner, setHasOwner] = useState<boolean | null>(null)
  const [loginUsers, setLoginUsers] = useState<{ name: string | null; hasPassword: boolean }[] | null>(null)
  const [selectedUserName, setSelectedUserName] = useState('')

  useEffect(() => {
    api.authStatus()
      .then(s => {
        setHasOwner(s.hasOwner)
        if (!s.hasOwner) setMode('register')
      })
      .catch(() => setHasOwner(true))
  }, [])

  // Probe companion for register/recovery mode
  useEffect(() => {
    if (mode !== 'register' && mode !== 'recovery' && hasOwner !== false) return
    if (hasOwner === null) return
    let cancelled = false
    async function probeAgentForRegister() {
      setRegisterAgentState('probing')
      setAgentPubKey(null)
      try {
        const base = await probeAgentUrl()
        if (!base) throw new Error('unavailable')
        if (!cancelled) setAgentUrl(base)
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS)
        const pkRes = await fetch(`${base}/pubkey`, { signal: ctrl.signal })
        clearTimeout(timer)
        if (!pkRes.ok) throw new Error('no pubkey')
        const { pubKey } = await pkRes.json()
        if (!pubKey) throw new Error('empty pubkey')
        if (!cancelled) { setAgentPubKey(pubKey); setRegisterAgentState('ready') }
      } catch {
        if (!cancelled) setRegisterAgentState('unavailable')
      }
    }
    probeAgentForRegister()
    return () => { cancelled = true }
  }, [mode, hasOwner])

  // Auto-login via companion
  useEffect(() => {
    if (mode !== 'login' || hasOwner === false) return
    let cancelled = false
    async function tryAgent() {
      let base: string | null
      try {
        base = await probeAgentUrl()
        if (!base) throw new Error('unavailable')
        if (!cancelled) setAgentUrl(base)
      } catch {
        if (!cancelled) setAgentState('unavailable')
        return
      }
      if (cancelled) return
      setAgentState('signing')
      try {
        const BASE = import.meta.env.DEV ? '/api' : ''
        const { challenge } = await fetch(`${BASE}/auth/challenge`).then(r => r.json())
        const ctrl2 = new AbortController()
        const timer2 = setTimeout(() => ctrl2.abort(), AGENT_TIMEOUT_MS)
        const signRes = await fetch(`${base}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge }),
          signal: ctrl2.signal,
        })
        clearTimeout(timer2)
        if (!signRes.ok) throw new Error('sign failed')
        const { signature } = await signRes.json()
        const BASE2 = import.meta.env.DEV ? '/api' : ''
        const verifyRes = await fetch(`${BASE2}/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge, signature }),
        })
        if (!verifyRes.ok) throw new Error('verify failed')
        const resp: LoginResponse = await verifyRes.json()
        if (!cancelled) onLogin(resp)
      } catch {
        if (!cancelled) setAgentState('available')
      }
    }
    tryAgent()
    return () => { cancelled = true }
  }, [mode, hasOwner])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const BASE = import.meta.env.DEV ? '/api' : ''
      const { challenge } = await fetch(`${BASE}/auth/challenge`).then(r => r.json())
      const signature = await signChallenge(passphrase, challenge)
      const res = await fetch(`${BASE}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, signature }),
      })
      if (!res.ok) { setError('Invalid passphrase.'); return }
      const resp: LoginResponse = await res.json()
      onLogin(resp)
    } catch {
      setError('Could not reach server.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (mode !== 'password') return
    api.getLoginUsers()
      .then(({ users }) => setLoginUsers(users.filter(u => u.hasPassword)))
      .catch(() => setLoginUsers([]))
  }, [mode])

  async function handleLoginWithPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const resp = await api.loginWithPassword(password, selectedUserName || undefined)
      onLogin(resp)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid password.')
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const usingAgent = registerAgentState === 'ready' && agentPubKey !== null
      const pubKey = usingAgent ? agentPubKey! : await deriveAuthPubKey(passphrase)
      await api.register(pubKey, inviteToken || undefined, name || undefined, recoveryPassword || undefined)
      const BASE = import.meta.env.DEV ? '/api' : ''
      const { challenge } = await fetch(`${BASE}/auth/challenge`).then(r => r.json())
      let signature: string
      if (usingAgent) {
        const signRes = await fetch(`${agentUrl}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge }),
        })
        if (!signRes.ok) throw new Error('Agent signing failed after registration.')
        signature = (await signRes.json()).signature
      } else {
        signature = await signChallenge(passphrase, challenge)
      }
      const res = await fetch(`${BASE}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, signature }),
      })
      if (!res.ok) { setError('Registered but login failed. Try logging in.'); return }
      const resp: LoginResponse = await res.json()
      onLogin(resp)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const usingAgent = registerAgentState === 'ready' && agentPubKey !== null
      const newPubKey = usingAgent ? agentPubKey! : await deriveAuthPubKey(passphrase)
      const resp = await api.recover(recoveryPassword, newPubKey)
      onLogin(resp)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery failed.')
    } finally {
      setLoading(false)
    }
  }

  const isFirstSetup = hasOwner === false
  const showCompanionUnavailable = agentState === 'unavailable' && mode === 'login'

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-white mb-1">
          <span className="text-indigo-400">⬡</span> MediaForest
        </h1>

        {agentState === 'probing' && mode === 'login' && !isFirstSetup && (
          <p className="text-sm text-gray-500 mt-3">Checking for local companion…</p>
        )}
        {agentState === 'signing' && mode === 'login' && (
          <p className="text-sm text-indigo-400 mt-3">Signing with companion…</p>
        )}

        {/* ── Password login (no companion) ── */}
        {mode === 'password' && (
          <>
            <p className="text-sm text-gray-400 mt-2 mb-4">Sign in with your account password.</p>
            <form onSubmit={handleLoginWithPassword} className="flex flex-col gap-3">
              {loginUsers && loginUsers.length > 1 && (
                <select
                  value={selectedUserName}
                  onChange={e => setSelectedUserName(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Select your account…</option>
                  {loginUsers.map((u, i) => (
                    <option key={i} value={u.name ?? ''}>{u.name ?? '(unnamed)'}</option>
                  ))}
                </select>
              )}
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                autoFocus
                className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !password}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
            <div className="mt-4 flex flex-col gap-2 items-center">
              <button
                onClick={() => { setMode('login'); setError('') }}
                className="text-xs text-gray-600 hover:text-gray-400"
              >
                ← Other login options
              </button>
              <button
                onClick={() => { setMode('recovery'); setError('') }}
                className="text-xs text-gray-700 hover:text-gray-500"
              >
                Lost access? Recover with recovery password →
              </button>
            </div>
          </>
        )}

        {/* ── Recovery key-rotation mode ── */}
        {mode === 'recovery' && (
          <>
            <p className="text-sm text-gray-400 mb-1 mt-2">Recover account access.</p>
            <p className="text-xs text-gray-600 mb-3">This rotates your key. Use this only when your passphrase and companion are both gone.</p>
            {registerAgentState === 'probing' && (
              <p className="text-xs text-gray-500 mb-2">Checking for companion…</p>
            )}
            {registerAgentState === 'ready' && (
              <p className="text-xs text-indigo-400 mb-2">Companion found — new key from companion.</p>
            )}
            <form onSubmit={handleRecover} className="flex flex-col gap-3 mt-2">
              <input
                type="password"
                value={recoveryPassword}
                onChange={e => setRecoveryPassword(e.target.value)}
                placeholder="Recovery password"
                autoFocus
                className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
              />
              {registerAgentState !== 'ready' && (
                <input
                  type="password"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  placeholder="New passphrase (for new key)"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              )}
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !recoveryPassword || (registerAgentState !== 'ready' && !passphrase)}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                {loading ? 'Recovering…' : 'Rotate Key & Recover'}
              </button>
            </form>
            <button
              onClick={() => { setMode('login'); setError('') }}
              className="mt-4 text-xs text-gray-600 hover:text-gray-400 w-full text-center"
            >
              ← Back to login
            </button>
          </>
        )}

        {/* ── Login / register / first-setup ── */}
        {mode !== 'recovery' && mode !== 'password' && (isFirstSetup || mode === 'register' || agentState === 'unavailable' || agentState === 'available') && (
          <>
            {isFirstSetup ? (
              <>
                <p className="text-sm text-gray-400 mb-1 mt-2">Set up this server — create your owner account.</p>
                <p className="text-xs text-gray-600 mb-3">Your passphrase becomes your identity. It never leaves this browser. Set a recovery password too — you'll need it to log in from other devices.</p>
              </>
            ) : mode === 'register' ? (
              <p className="text-sm text-gray-400 mb-1 mt-2">Register with an invite from the server owner.</p>
            ) : (
              <p className="text-sm text-gray-500 mb-1 mt-1">Enter your passphrase to continue.</p>
            )}

            {/* Companion unavailable banner */}
            {showCompanionUnavailable && (
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 mb-4 text-xs">
                <p className="text-gray-300 font-medium mb-1">Companion not running</p>
                <p className="text-gray-500 mb-2">
                  The MediaForest companion keeps your key so you don't have to type a passphrase.
                  {' '}<a href="https://github.com/christcb03/phrasevault#local-auth-agent" target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300">Install companion →</a>
                </p>
                <p className="text-gray-500">
                  Already have a password?{' '}
                  <button
                    onClick={() => { setMode('password'); setError('') }}
                    className="text-indigo-400 hover:text-indigo-300 underline"
                  >
                    Sign in with password
                  </button>
                </p>
              </div>
            )}

            {(mode === 'register' || isFirstSetup) && registerAgentState === 'probing' && (
              <p className="text-xs text-gray-500 mt-1 mb-2">Checking for companion…</p>
            )}
            {(mode === 'register' || isFirstSetup) && registerAgentState === 'ready' && (
              <p className="text-xs text-indigo-400 mt-1 mb-2">Companion detected — no passphrase needed.</p>
            )}
            {(mode === 'register' || isFirstSetup) && registerAgentState === 'unavailable' && (
              <p className="text-xs text-gray-500 mt-1 mb-2">
                No companion — you'll use a passphrase instead.{' '}
                <a href="https://github.com/christcb03/phrasevault#local-auth-agent" target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300">Install companion</a>
              </p>
            )}

            <form
              onSubmit={mode === 'register' || isFirstSetup ? handleRegister : handleLogin}
              className="flex flex-col gap-3 mt-3"
            >
              {(mode === 'register' || isFirstSetup) && (
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Your name (optional)"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              )}
              {((mode === 'register' || isFirstSetup) ? registerAgentState !== 'ready' : true) && (
                <input
                  type="password"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  placeholder={isFirstSetup || mode === 'register' ? 'Passphrase (your identity key)' : 'Passphrase'}
                  autoFocus={registerAgentState !== 'ready' && !showCompanionUnavailable}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              )}
              {mode === 'register' && !isFirstSetup && (
                <input
                  type="text"
                  value={inviteToken}
                  onChange={e => setInviteToken(e.target.value)}
                  placeholder="Invite token"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              )}
              {(mode === 'register' || isFirstSetup) && (
                <>
                  <input
                    type="password"
                    value={recoveryPassword}
                    onChange={e => setRecoveryPassword(e.target.value)}
                    placeholder="Password (lets you log in from any device)"
                    className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-xs text-gray-600 -mt-1">This password also lets you recover your account. Minimum 8 characters.</p>
                </>
              )}
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={
                  loading ||
                  ((mode === 'register' || isFirstSetup)
                    ? (registerAgentState === 'probing' || (registerAgentState !== 'ready' && !passphrase))
                    : !passphrase)
                }
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                {loading
                  ? (mode === 'register' || isFirstSetup ? 'Registering…' : 'Unlocking…')
                  : (mode === 'register' || isFirstSetup ? 'Create Account' : 'Unlock')}
              </button>
            </form>

            {!isFirstSetup && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}
                  className="text-xs text-gray-600 hover:text-gray-400 text-center"
                >
                  {mode === 'login' ? 'Have an invite? Register →' : '← Back to login'}
                </button>
                {mode === 'login' && agentState !== 'probing' && agentState !== 'signing' && (
                  <button
                    onClick={() => { setMode('recovery'); setError('') }}
                    className="text-xs text-gray-700 hover:text-gray-500 text-center"
                  >
                    Lost your passphrase and companion? Recover →
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
