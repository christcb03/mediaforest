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
type Mode = 'login' | 'register'

export default function LoginPage({ onLogin }: Props) {
  const [passphrase, setPassphrase] = useState('')
  const [name, setName] = useState('')
  const [inviteToken, setInviteToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [agentState, setAgentState] = useState<AgentState>('probing')
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
      const pubKey = await deriveAuthPubKey(passphrase)
      await api.register(pubKey, inviteToken || undefined, name || undefined)
      // Immediately log in after registering
      const BASE = import.meta.env.DEV ? '/api' : ''
      const { challenge } = await fetch(`${BASE}/auth/challenge`).then(r => r.json())
      const signature = await signChallenge(passphrase, challenge)
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

        {(isFirstSetup || mode === 'register' || agentState === 'unavailable' || agentState === 'available') && (
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
              <input
                type="password"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                placeholder="Passphrase"
                autoFocus
                className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
              />
              {mode === 'register' && !isFirstSetup && (
                <input
                  type="text"
                  value={inviteToken}
                  onChange={e => setInviteToken(e.target.value)}
                  placeholder="Invite token"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
                />
              )}
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !passphrase}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                {loading
                  ? (mode === 'register' || isFirstSetup ? 'Registering…' : 'Unlocking…')
                  : (mode === 'register' || isFirstSetup ? 'Register' : 'Unlock')}
              </button>
            </form>

            {!isFirstSetup && (
              <button
                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}
                className="mt-4 text-xs text-gray-600 hover:text-gray-400 w-full text-center"
              >
                {mode === 'login' ? 'Have an invite? Register instead →' : '← Back to login'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
