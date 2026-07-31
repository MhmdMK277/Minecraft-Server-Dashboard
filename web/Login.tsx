import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dashboard } from './client'
import logo from '../docs/images/logo.png'

/**
 * Sign-in, and the forced password change that follows a first start.
 *
 * Deliberately the whole screen rather than a modal over the dashboard: there
 * is nothing behind it to look at, and a dimmed-but-visible console would be
 * showing exactly what the login exists to protect.
 */
export default function Login({
  mustChangePassword,
  username,
  onDone,
}: {
  mustChangePassword: boolean
  username?: string
  onDone: () => void
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {mustChangePassword ? (
          <ChangePassword username={username} onDone={onDone} />
        ) : (
          <SignIn onDone={onDone} />
        )}
      </div>
    </div>
  )
}

/** The brand block, inside the card rather than floating detached above it. */
function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-secondary ring-1 ring-border">
        <img src={logo} alt="" width={30} height={30} className="rounded-[4px]" />
      </span>
      <div>
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
          Minecraft Server Dashboard
        </h1>
        <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>
      </div>
    </div>
  )
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await dashboard.login(username, password)
      // The socket was opened unauthenticated, or not at all. Re-open it so the
      // console starts streaming under this identity.
      dashboard.reconnect()
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="surface rounded-xl border border-border bg-card p-6">
      <Brand subtitle="Sign in to watch and control your servers." />
      <p className="prose-line mt-4 text-[11px] leading-relaxed text-faint">
        On a first start the username and password were printed once in the terminal that started
        this service.
      </p>
      <Field label="Username" value={username} onChange={setUsername} autoFocus autoComplete="username" />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="current-password"
      />
      {err && <Problem>{err}</Problem>}
      <Button type="submit" disabled={busy || !username || !password} className="mt-4 w-full">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}

function ChangePassword({ username, onDone }: { username?: string; onDone: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && next !== again
  const tooShort = next.length > 0 && next.length < 12

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await dashboard.changePassword(current, next)
      dashboard.reconnect()
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="surface rounded-xl border border-warn/50 bg-card p-6">
      <Brand subtitle="One thing before the dashboard opens." />
      <h2 className="mt-4 text-[12px] font-semibold text-warn">Choose a password</h2>
      <p className="prose-line mt-1 text-[12px] leading-relaxed text-muted">
        {username ? `${username} is ` : 'This account is '}still using the password generated at
        first start, which was printed to a terminal and may still be in its scrollback. Replacing it
        signs out every other session.
      </p>
      <Field
        label="Current password"
        value={current}
        onChange={setCurrent}
        type="password"
        autoFocus
        autoComplete="current-password"
      />
      <Field
        label="New password (12 characters or more)"
        value={next}
        onChange={setNext}
        type="password"
        autoComplete="new-password"
      />
      <Field
        label="New password again"
        value={again}
        onChange={setAgain}
        type="password"
        autoComplete="new-password"
      />
      {tooShort && <Problem>That is {next.length} characters; 12 is the minimum.</Problem>}
      {mismatch && <Problem>The two new passwords do not match.</Problem>}
      {err && <Problem>{err}</Problem>}
      <Button
        type="submit"
        disabled={busy || !current || next.length < 12 || next !== again}
        className="mt-4 w-full"
      >
        {busy ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoFocus,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoFocus?: boolean
  autoComplete?: string
}) {
  return (
    <label className="mt-3.5 block">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <Input
        type={type}
        value={value}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 text-[13px]"
      />
    </label>
  )
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-2 py-1.5 text-[12px] text-bad">
      {children}
    </p>
  )
}
