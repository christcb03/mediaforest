import { useState, useEffect } from 'react'
import { signChallenge, deriveAuthPubKey } from './crypto'
import { api } from './api'
import type { LoginResponse } from './api'

const AGENT_URL = 'http://localhost:8765'
const AGENT_TIMEOUT_MS = 2000

interface Props {
  onLogin: (resp: LoginResponse) => void
}

type AgentState = 'probing' | 'signing' | 'available' | 'unavailable'
type Mode = 'login' | 'register' | 'recovery'
type RegisterAgentState = 'idle' | 'probing' | 'ready' | 'unavailable'

export default function LoginPage({ onLogin }: Props) {
  const [passphrase, setPassphrase] = useState('')
  const [name, setName] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [agentState, setAgentState] = useState<AgentState>('probing')
  const [registerAgentState, setRegisterAgentState] = useState<RegisterAgentState>('idle')
  const [agentPubKey, setAgentPubKey] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('login')
  const [hasOwner, setHasOwner] = useState<boolean | null>(null)

  // Check server registration status
  useEffect(() => {
    api.authStatus()
      .then(s => {
        setHasOwner(s.hasOwner)
        if (!s.hasOwner) setMode('register')
      })
      .catch(() => setHasOwner(true)) // assume registered on error
  }, [])

  // Probe companion for register mode — fetch pubkey so no passphrase needed
  useEffect(() => {
    if (mode !== 'register' && mode !== 'recovery' && hasOwner !== false) return
    if (hasOwner === null) return
    let cancelled = false

    async function probeAgentForRegister() {
      setRegisterAgentState('probing')
      setAgentPubKey(null)
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS)
        const health = await fetch(`${AGENT_URL}/health`, { signal: ctrl.signal })
        clearTimeout(timer)
        if (!health.ok) throw new Error('unhealthy')
        const { ok } = await health.json()
        if (!ok) throw new Error('not ok')

        const ctrl2 = new AbortController()
        const timer2 = setTimeout(() => ctrl2.abort(), AGENT_TIMEOUT_MS)
        const pkRes = await fetch(`${AGENT_URL}/pubkey`, { signal: ctrl2.signal })
        clearTimeout(timer2)
        if (!pkRes.ok) throw new Error('no pubkey')
        const { pubKey } = await pkRes.json()
        if (!pubKey) throw new Error('empty pubkey')

        if (!cancelled) {
          setAgentPubKey(pubKey)
          setRegisterAgentState('ready')
        }
      } catch {
        if (!cancelled) setRegisterAgentState('unavailable')
      }
    }

    probeAgentForRegister()
    return () => { cancelled = true }
  }, [mode, hasOwner])  // fires for 'register' and 'recovery' modes

  // Try local agent for login mode
  useEffect(() => {
    if (mode !== 'login' || hasOwner === false) return
    let cancelled = false

    async function tryAgent() {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS)
        const health = await fetch(`${AGENT_URL}/health`, { signal: ctrl.signal })
        clearTimeout(timer)
        if (!health.ok) throw new Error('unhealthy')
        const { ok } = await health.json()
        if (!ok) throw new Error('not ok')
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
        const signRes = await fetch(`${AGENT_URL}/sign`, {
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
      } catch (err) {
        if (!cancelled) {
          setAgentState('available')
          setError('Agent found but login failed. Enter passphrase manually.')
        }
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

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const usingAgent = registerAgentState === 'ready' && agentPubKey !== null
      const pubKey = usingAgent ? agentPubKey! : await deriveAuthPubKey(passphrase)
      await api.register(pubKey, inviteToken || undefined, name || undefined, recoveryPassword || undefined)

      // Immediately log in after registering
      const BASE = import.meta.env.DEV ? '/api' : ''
      const { challenge } = await fetch(`${BASE}/auth/challenge`).then(r => r.json())

      let signature: string
      if (usingAgent) {
        const signRes = await fetch(`${AGENT_URL}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge }),
        })
        if (!signRes.ok) throw new Error('Agent signing failed after registration.')
        const body = await signRes.json()
        signature = body.signature
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

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-white mb-1">
          <span className="text-indigo-400">⬡</span> MediaForest
        </h1>

        {agentState === 'probing' && mode === 'login' && !isFirstSetup && (
          <p className="text-sm text-gray-500 mt-3">Checking for local auth agent…</p>
        )}

        {agentState === 'signing' && mode === 'login' && (
          <p className="text-sm text-indigo-400 mt-3">Signing with local agent…</p>
        )}

        {/* ── Recovery mode ── */}
        {mode === 'recovery' && (
          <>
            <p className="text-sm text-gray-400 mb-1 mt-2">Recover account access.</p>
            <p className="text-xs text-gray-600 mb-3">Enter your recovery password, then provide your new passphrase (or let the agent supply the new key).</p>

            {registerAgentState === 'probing' && (
              <p className="text-xs text-gray-500 mb-2">Checking for local auth agent…</p>
            )}
            {registerAgentState === 'ready' && (
              <p className="text-xs text-indigo-400 mb-2">Local auth agent detected — new key will come from agent.</p>
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
                  placeholder="New passphrase"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              )}
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !recoveryPassword || (registerAgentState !== 'ready' && !passphrase)}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                {loading ? 'Recovering…' : 'Recover Access'}
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
        {mode !== 'recovery' && (isFirstSetup || mode === 'register' || agentState === 'unavailable' || agentState === 'available') && (
          <>
            {isFirstSetup ? (
              <p className="text-sm text-gray-400 mb-1 mt-2">Set up this server — create your owner account.</p>
            ) : mode === 'register' ? (
              <p className="text-sm text-gray-400 mb-1 mt-2">Register with an invite from the server owner.</p>
            ) : (
              <>
                <p className="text-sm text-gray-500 mb-1 mt-1">Enter your passphrase to continue.</p>
                <p className="text-xs text-gray-600 mb-2">This is your personal identity — the same passphrase you registered with.</p>
              </>
            )}

            {agentState === 'unavailable' && mode === 'login' && (
              <p className="text-xs text-gray-600 mb-4">
                Local auth agent not running — passphrase required.{' '}
                <a
                  href="https://github.com/christcb03/phrasevault#local-auth-agent"
                  className="text-indigo-500 hover:text-indigo-400"
                  target="_blank" rel="noreferrer"
                >
                  Set up agent
                </a>
              </p>
            )}

            {(mode === 'register' || isFirstSetup) && registerAgentState === 'probing' && (
              <p className="text-xs text-gray-500 mt-1 mb-2">Checking for local auth agent…</p>
            )}

            {(mode === 'register' || isFirstSetup) && registerAgentState === 'ready' && (
              <p className="text-xs text-indigo-400 mt-1 mb-2">
                Local auth agent detected — no passphrase needed.
              </p>
            )}

            <form
              onSubmit={mode === 'register' || isFirstSetup ? handleRegister : handleLogin}
              className="flex flex-col gap-3 mt-4"
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
                  placeholder="Passphrase"
                  autoFocus={registerAgentState !== 'ready'}
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
                <input
                  type="password"
                  value={recoveryPassword}
                  onChange={e => setRecoveryPassword(e.target.value)}
                  placeholder="Recovery password (recommended)"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
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
                  : (mode === 'register' || isFirstSetup ? 'Register' : 'Unlock')}
              </button>
            </form>

            {!isFirstSetup && (
              <div className="mt-4 flex flex-col items-center gap-2">
                <button
                  onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}
                  className="text-xs text-gray-600 hover:text-gray-400 text-center"
                >
                  {mode === 'login' ? 'Have an invite? Register instead →' : '← Back to login'}
                </button>
                {mode === 'login' && (
                  <button
                    onClick={() => { setMode('recovery'); setError('') }}
                    className="text-xs text-gray-700 hover:text-gray-500 text-center"
                  >
                    Can't access your passphrase?
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
