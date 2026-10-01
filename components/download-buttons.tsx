"use client"

import { Dialog } from "@base-ui/react/dialog"
import { useRef, useState, type FormEvent } from "react"
import {
  ArrowDownToLine,
  Check,
  Cpu,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"

const builds = [
  {
    architecture: "arm64",
    label: "Apple Silicon",
    hint: "M-series chips",
    variant: "default",
  },
  {
    architecture: "x64",
    label: "Intel Mac",
    hint: "Intel processors",
    variant: "outline",
  },
] as const

export function DownloadButtons({
  downloadError,
  waitlistHandle,
}: {
  downloadError?: string
  waitlistHandle: Dialog.Handle<void>
}) {
  const [selected, setSelected] = useState<(typeof builds)[number] | null>(null)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)

  function close() {
    setSelected(null)
    setPassword("")
    setError("")
  }

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || busy) return
    setBusy(true)
    setError("")
    try {
      const path = `/api/download/${selected.architecture}`
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (!response.ok) {
        const result = await response.json()
        setError(result.error || "Something went wrong. Please try again.")
        setPassword("")
        return
      }
      close()
      setStarted(true)
      // Stream directly to disk, without holding a large installer blob in memory.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- An attachment requires a native browser navigation, not an RSC navigation.
      window.location.assign(path)
    } catch {
      setError("Couldn't connect. Please check your connection and try again.")
    } finally {
      setBusy(false)
      requestAnimationFrame(() => input.current?.focus())
    }
  }

  return (
    <>
      <div className="download-buttons">
        {builds.map((build) => (
          <div key={build.architecture} className="download-option">
            <Button
              variant={build.variant}
              className="download-button"
              aria-haspopup="dialog"
              onClick={(event) => {
                trigger.current = event.currentTarget
                setSelected(build)
                setStarted(false)
                setError("")
              }}
            >
              <ArrowDownToLine size={17} aria-hidden="true" />
              Download for {build.label}
            </Button>
            <span className="chip-hint">
              <Cpu size={12} aria-hidden="true" />
              {build.hint}
            </span>
          </div>
        ))}
      </div>
      {downloadError && !selected && !started && (
        <p className="download-message download-error" role="alert">
          {downloadError === "locked"
            ? "Your access has expired. Select a download and enter your password again."
            : "This download isn't available right now. Please try again later."}
        </p>
      )}
      {started && (
        <p className="download-message" role="status">
          <Check size={14} aria-hidden="true" />
          Your download is starting.
        </p>
      )}
      <Dialog.Root
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) close()
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="password-backdrop" />
          <Dialog.Popup
            className="password-dialog"
            initialFocus={input}
            finalFocus={() => (waitlistHandle.isOpen ? false : trigger.current)}
          >
            <Dialog.Close
              className="dialog-close"
              aria-label="Close password prompt"
              disabled={busy}
            >
              <X size={18} />
            </Dialog.Close>
            <div className="dialog-lock">
              <LockKeyhole size={21} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <p className="eyebrow dialog-eyebrow">You&apos;re here early</p>
            <Dialog.Title className="dialog-title">
              A first look at photodepot.
            </Dialog.Title>
            <Dialog.Description className="dialog-description">
              Enter your download password to get photodepot for{" "}
              {selected?.label}.
            </Dialog.Description>
            <form onSubmit={download} className="password-form">
              <label htmlFor="download-password">Download password</label>
              <input
                ref={input}
                id="download-password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setError("")
                }}
                aria-invalid={!!error}
                aria-describedby={error ? "password-error" : undefined}
                disabled={busy}
                maxLength={1024}
                required
              />
              {error && (
                <p id="password-error" className="password-error" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="dialog-submit"
                disabled={busy || !password}
              >
                {busy ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowDownToLine aria-hidden="true" />
                )}
                {busy ? "Checking access…" : "Unlock download"}
              </Button>
            </form>
            <p className="download-invite">
              Don&apos;t have an invite?{" "}
              <Dialog.Trigger
                handle={waitlistHandle}
                disabled={busy}
                render={<Button variant="link" className="waitlist-button" />}
                onClick={close}
              >
                Join the waitlist
              </Dialog.Trigger>
            </p>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
