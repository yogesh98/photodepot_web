"use client"

import { Dialog } from "@base-ui/react/dialog"
import { Check, LoaderCircle, Mail, X } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { WAITLIST_LIMITS } from "@/lib/waitlist-validation"

export function WaitlistButton({ handle }: { handle: Dialog.Handle<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [joined, setJoined] = useState(false)
  const [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const done = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (joined) done.current?.focus()
  }, [joined])

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(fields)),
      })
      if (!response.ok) {
        const result = await response.json()
        setError(result.error || "Something went wrong. Please try again.")
        return
      }
      setJoined(true)
    } catch {
      setError("Couldn't connect. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root
      handle={handle}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          if (nextOpen) {
            setJoined(false)
            setError("")
          }
          setOpen(nextOpen)
        }
      }}
    >
      <div className="waitlist-action">
        <Button
          ref={trigger}
          variant="link"
          className="waitlist-button"
          aria-haspopup="dialog"
          onClick={() => {
            setJoined(false)
            setError("")
            setOpen(true)
          }}
        >
          Join the waitlist
        </Button>
      </div>
      <Dialog.Portal>
        <Dialog.Backdrop className="password-backdrop" />
        <Dialog.Popup
          className="password-dialog waitlist-dialog"
          initialFocus={input}
          finalFocus={trigger}
        >
          <Dialog.Close
            className="dialog-close"
            aria-label="Close waitlist form"
            disabled={busy}
          >
            <X size={18} />
          </Dialog.Close>
          <div className="dialog-lock">
            {joined ? (
              <Check size={21} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Mail size={21} strokeWidth={1.5} aria-hidden="true" />
            )}
          </div>
          <Dialog.Title className="dialog-title">
            {joined ? "You're on the list." : "A little more about you."}
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            {joined
              ? "Thanks for your interest in photodepot. We'll be in touch when there's more to share."
              : "Join the photodepot waitlist and hear when we're ready for you."}
          </Dialog.Description>
          {joined ? (
            <div role="status">
              <p className="waitlist-confirmation">
                Your interest is registered.
              </p>
              <Button
                ref={done}
                className="dialog-submit waitlist-done"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={join} className="waitlist-form" aria-busy={busy}>
              <p className="waitlist-required-note">
                All fields required except last name.
              </p>
              <fieldset disabled={busy}>
                <div className="waitlist-name-fields">
                  <div className="waitlist-field">
                    <label htmlFor="waitlist-first-name">First name</label>
                    <input
                      ref={input}
                      id="waitlist-first-name"
                      name="firstName"
                      autoComplete="given-name"
                      maxLength={WAITLIST_LIMITS.firstName}
                      required
                    />
                  </div>
                  <div className="waitlist-field">
                    <label htmlFor="waitlist-last-name">
                      Last name <span>(optional)</span>
                    </label>
                    <input
                      id="waitlist-last-name"
                      name="lastName"
                      autoComplete="family-name"
                      maxLength={WAITLIST_LIMITS.lastName}
                    />
                  </div>
                </div>
                <div className="waitlist-field">
                  <label htmlFor="waitlist-email">Email</label>
                  <input
                    id="waitlist-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={WAITLIST_LIMITS.email}
                    required
                  />
                </div>
                <div className="waitlist-field">
                  <label htmlFor="waitlist-source">
                    How did you hear about us?
                  </label>
                  <input
                    id="waitlist-source"
                    name="heardAboutUs"
                    placeholder="A friend, Instagram, a search…"
                    maxLength={WAITLIST_LIMITS.heardAboutUs}
                    required
                  />
                </div>
              </fieldset>
              {error && (
                <p className="password-error" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="dialog-submit" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Mail aria-hidden="true" />
                )}
                {busy ? "Joining…" : "Join the waitlist"}
              </Button>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
