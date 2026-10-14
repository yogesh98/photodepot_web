"use client"

import Link from "next/link"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import type { LicenseAudit, LicenseSummary } from "@/lib/license-types"
import styles from "./license-dashboard.module.css"

type PendingAction = {
  license: LicenseSummary
  action: "revoke" | "restore" | "reset-device" | "set-type"
}
class SessionExpiredError extends Error {
  constructor() {
    super("Your session expired. Sign in in a new tab, then select Refresh.")
  }
}
function DashboardError({
  message,
  sessionExpired,
}: {
  message: string
  sessionExpired: boolean
}) {
  return (
    <p role="alert" className={styles.error}>
      {message}{" "}
      {sessionExpired && (
        <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
          Sign in
        </a>
      )}
    </p>
  )
}
function DashboardDialog({
  children,
  onClose,
  titleId,
}: {
  children: ReactNode
  onClose: () => void
  titleId: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLElement>("[data-dialog-focus]")?.focus()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.overlay}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <section className={styles.modal}>{children}</section>
    </dialog>
  )
}
function date(value: number | null) {
  return value ? new Date(value).toLocaleString() : "Never"
}
async function api(body?: object, query = "") {
  const response = await fetch(`/api/admin/licenses${query}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 401) throw new SessionExpiredError()
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error("Unable to read the server response. Try again.")
  }
  if (!response.ok)
    throw new Error(result.error || "Unable to save this change.")
  return result
}
export function LicenseDashboard() {
  const [licenses, setLicenses] = useState<LicenseSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [notice, setNotice] = useState("")
  const [newKey, setNewKey] = useState("")
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [audit, setAudit] = useState<{
    license: LicenseSummary
    entries: LicenseAudit[]
  } | null>(null)
  const handleError = useCallback((cause: unknown) => {
    setError(
      cause instanceof Error
        ? cause.message
        : "Unable to complete this request."
    )
    if (cause instanceof SessionExpiredError) setSessionExpired(true)
  }, [])
  const load = useCallback(
    async (next?: string) => {
      setLoading(true)
      setError("")
      try {
        const result = await api(
          undefined,
          next ? `?cursor=${encodeURIComponent(next)}` : ""
        )
        setLicenses((previous) =>
          next ? [...previous, ...result.licenses] : result.licenses
        )
        setCursor(result.nextCursor)
        setSessionExpired(false)
      } catch (cause) {
        handleError(cause)
      } finally {
        setLoading(false)
      }
    },
    [handleError]
  )
  useEffect(() => {
    let active = true
    void api()
      .then((result) => {
        if (!active) return
        setLicenses(result.licenses)
        setCursor(result.nextCursor)
        setSessionExpired(false)
      })
      .catch((cause: Error) => {
        if (active) handleError(cause)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [handleError])
  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const result = await api({
        action: "grant",
        type: values.get("type"),
        customerName: values.get("customerName"),
        email: values.get("email"),
        notes: values.get("notes"),
      })
      setNewKey(result.key)
      form.reset()
      await load()
    } catch (cause) {
      handleError(cause)
    } finally {
      setBusy(false)
    }
  }
  async function change() {
    if (!pending) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await api({
        action: pending.action,
        id: pending.license.id,
        ...(pending.action === "set-type"
          ? { type: pending.license.type === "trial" ? "regular" : "trial" }
          : {}),
      })
      setNotice(
        pending.action === "reset-device"
          ? "Mac assignment reset. The previous Mac will need to reactivate when the app is closed and reopened. Its current session and collaboration continue until then."
          : pending.action === "revoke"
            ? "License revoked. Local access will be blocked when the app is closed and reopened. The current session and collaboration continue until then."
            : "License updated. Connected Macs receive this change at their next verification."
      )
      setPending(null)
      await load()
    } catch (cause) {
      handleError(cause)
    } finally {
      setBusy(false)
    }
  }
  async function history(license: LicenseSummary) {
    setBusy(true)
    setError("")
    try {
      const result = await api(undefined, `?id=${license.id}`)
      setAudit({ license, entries: result.audit })
    } catch (cause) {
      handleError(cause)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          photodepot
        </Link>
        <div className={styles.accountActions}>
          <span>Administration</span>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className={styles.quiet}
              disabled={busy || Boolean(newKey)}
              title={
                newKey
                  ? "Save the displayed license key before signing out."
                  : undefined
              }
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>License management</p>
          <h1>Licenses</h1>
          <p>
            Grant trial and regular licenses, manage Mac assignments, and
            control access.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
        >
          Refresh
        </button>
      </div>
      {error && (
        <DashboardError message={error} sessionExpired={sessionExpired} />
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {newKey && (
        <section className={styles.keyPanel} aria-labelledby="new-key-title">
          <div>
            <p className={styles.eyebrow}>License granted</p>
            <h2 id="new-key-title">Save this key before closing.</h2>
            <p>
              The full key is shown only once. Send it to the customer
              privately.
            </p>
          </div>
          <code>{newKey}</code>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(newKey)
                  setNotice("License key copied.")
                } catch {
                  setError("Copy the displayed license key manually.")
                }
              }}
            >
              Copy license key
            </button>
            <button
              type="button"
              className={styles.quiet}
              onClick={() => {
                setNewKey("")
                setNotice("")
              }}
            >
              I saved the key
            </button>
          </div>
        </section>
      )}
      <section className={styles.grant} aria-labelledby="grant-title">
        <div>
          <h2 id="grant-title">Grant a license</h2>
          <p>
            One Mac per license. Both types stay active until you revoke them.
          </p>
        </div>
        <form onSubmit={grant}>
          <label>
            Customer name
            <input
              name="customerName"
              required
              maxLength={160}
              autoComplete="off"
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
            />
          </label>
          <label>
            License type
            <select name="type" defaultValue="trial">
              <option value="trial">Trial</option>
              <option value="regular">Regular</option>
            </select>
          </label>
          <label className={styles.notes}>
            Notes
            <textarea
              name="notes"
              maxLength={2000}
              rows={2}
              placeholder="Optional customer details"
            />
          </label>
          <button
            type="submit"
            disabled={busy || sessionExpired || Boolean(newKey)}
          >
            {busy ? "Saving…" : "Grant license"}
          </button>
        </form>
      </section>
      <section className={styles.tableSection} aria-labelledby="licenses-title">
        <div className={styles.tableHeading}>
          <h2 id="licenses-title">
            Licenses{" "}
            <span>
              {licenses.length}
              {cursor ? "+" : ""}
            </span>
          </h2>
          <p>
            Offline launches are allowed for up to 48 hours or 10 startups
            between verifications. Revocation takes effect on the next app
            launch; current sessions and collaboration continue until quit.
          </p>
        </div>
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>Customer / key</th>
                <th>License</th>
                <th>Mac</th>
                <th>Last verification</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {licenses.map((license) => (
                <tr key={license.id}>
                  <td>
                    <strong>{license.customerName}</strong>
                    <a href={`mailto:${license.email}`}>{license.email}</a>
                    <code>PD-••••-{license.keySuffix}</code>
                    {license.notes && (
                      <p className={styles.rowNotes}>{license.notes}</p>
                    )}
                    <small>Created {date(license.createdAt)}</small>
                  </td>
                  <td>
                    <span className={styles.type}>{license.type}</span>
                    <span
                      className={
                        license.status === "active"
                          ? styles.active
                          : styles.revoked
                      }
                    >
                      {license.status}
                    </span>
                  </td>
                  <td>
                    {license.deviceId ? (
                      <code title={license.deviceId}>
                        {license.deviceId.slice(0, 12)}…
                      </code>
                    ) : (
                      <span className={styles.muted}>Not activated</span>
                    )}
                  </td>
                  <td>{date(license.lastVerifiedAt)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        disabled={busy || sessionExpired}
                        onClick={() =>
                          setPending({
                            license,
                            action:
                              license.status === "active"
                                ? "revoke"
                                : "restore",
                          })
                        }
                      >
                        {license.status === "active" ? "Revoke" : "Restore"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || sessionExpired}
                        onClick={() =>
                          setPending({ license, action: "set-type" })
                        }
                      >
                        Make {license.type === "trial" ? "regular" : "trial"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || sessionExpired || !license.deviceId}
                        onClick={() =>
                          setPending({ license, action: "reset-device" })
                        }
                      >
                        Reset Mac
                      </button>
                      <button
                        type="button"
                        disabled={busy || sessionExpired}
                        onClick={() => void history(license)}
                      >
                        History
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!licenses.length && (
          <p className={styles.empty}>
            {loading ? "Loading licenses…" : "No licenses to display."}
          </p>
        )}
        {cursor && (
          <button
            type="button"
            className={styles.more}
            onClick={() => void load(cursor)}
            disabled={loading || busy}
          >
            {loading ? "Loading…" : "Load more licenses"}
          </button>
        )}
      </section>
      <footer className={styles.footer}>
        Only Macs opening local projects need a license. Collaborators can join
        a licensed host without one.
      </footer>
      {pending && (
        <DashboardDialog
          titleId="change-title"
          onClose={() => {
            if (!busy) setPending(null)
          }}
        >
          <h2 id="change-title">
            {pending.action === "reset-device"
              ? "Reset this Mac assignment?"
              : pending.action === "set-type"
                ? "Change the license type?"
                : `${pending.action === "revoke" ? "Revoke" : "Restore"} this license?`}
          </h2>
          <p>
            {pending.license.customerName} · PD-••••-
            {pending.license.keySuffix}
          </p>
          <p>
            {pending.action === "reset-device"
              ? "The key can activate another Mac. The previous Mac will need to reactivate when the app is closed and reopened. Its current session and collaboration continue until then."
              : pending.action === "revoke"
                ? "Local project access will be blocked when the app is closed and reopened. The current session, ongoing work, and collaboration continue until then. Joining a licensed host remains available after reopening."
                : pending.action === "set-type"
                  ? `The license will become ${pending.license.type === "trial" ? "regular" : "trial"}. Its current status and Mac assignment stay the same.`
                  : "The assigned Mac can regain local project access after a successful online verification."}
          </p>
          {error && (
            <DashboardError message={error} sessionExpired={sessionExpired} />
          )}
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => void change()}
              disabled={busy || sessionExpired}
            >
              {busy ? "Saving…" : "Confirm change"}
            </button>
            <button
              type="button"
              className={styles.quiet}
              onClick={() => setPending(null)}
              disabled={busy}
              data-dialog-focus
            >
              Cancel
            </button>
          </div>
        </DashboardDialog>
      )}
      {audit && (
        <DashboardDialog titleId="history-title" onClose={() => setAudit(null)}>
          <h2 id="history-title">License history</h2>
          <p>
            {audit.license.customerName} · PD-••••-{audit.license.keySuffix}
          </p>
          <ol className={styles.history}>
            {audit.entries.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.detail}</strong>
                <span>
                  {date(entry.createdAt)} · {entry.actor}
                </span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => setAudit(null)}
            data-dialog-focus
          >
            Close history
          </button>
        </DashboardDialog>
      )}
    </main>
  )
}
