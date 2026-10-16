"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type {
  SubscriptionSummary,
  SubscriptionType,
} from "@/lib/subscription-types"
import styles from "./subscription-dashboard.module.css"

const day = 86_400_000
function localDate(value: number) {
  return new Date(value - new Date(value).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}
export type GrantValues = {
  type: SubscriptionType
  endsAt: number
  reason: string
  notes: string
}

/** The same expiry editor serves direct grants, extensions, and request approvals. */
export function AccessGrantEditor({
  subscription,
  extend,
  approval,
  disabled,
  busy,
  onSave,
  onClose,
}: {
  subscription: SubscriptionSummary | null
  extend: boolean
  approval: boolean
  disabled: boolean
  busy: boolean
  onSave: (values: GrantValues) => void
  onClose: () => void
}) {
  const [type, setType] = useState<SubscriptionType>(
    subscription?.type ?? "trial"
  )
  const [mode, setMode] = useState("duration")
  const [preset, setPreset] = useState(
    subscription?.type === "regular" ? "30" : "7"
  )
  const [customDays, setCustomDays] = useState("7")
  const [now] = useState(() => Date.now())
  const base =
    extend || approval ? Math.max(now, subscription?.endsAt ?? 0) : now
  const [exact, setExact] = useState(() =>
    localDate(base + Number(preset) * day)
  )
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState(subscription?.notes ?? "")
  const days = Number(preset === "custom" ? customDays : preset)
  const endsAt = mode === "date" ? new Date(exact).getTime() : base + days * day
  const valid =
    Number.isSafeInteger(endsAt) &&
    endsAt > base &&
    endsAt <= now + 3650 * day &&
    (mode === "date" || (Number.isInteger(days) && days >= 1 && days <= 3650))
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || disabled) return
    onSave({ type, endsAt, reason: reason.trim(), notes })
  }
  return (
    <form onSubmit={submit}>
      {subscription && (
        <p>Current expiry: {new Date(subscription.endsAt).toLocaleString()}.</p>
      )}
      <div className={styles.formFields}>
        {!extend && (
          <label>
            Access type
            <select
              value={type}
              onChange={(event) => {
                const value = event.target.value as SubscriptionType
                setType(value)
                setPreset(value === "trial" ? "7" : "30")
              }}
              disabled={disabled}
            >
              <option value="trial">Trial</option>
              <option value="regular">Standard</option>
            </select>
          </label>
        )}
        <label>
          Choose expiry by
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            disabled={disabled}
          >
            <option value="duration">
              {extend || approval ? "Add days" : "Duration from now"}
            </option>
            <option value="date">Exact date and time</option>
          </select>
        </label>
        {mode === "date" ? (
          <label>
            New expiry
            <Input
              type="datetime-local"
              value={exact}
              onChange={(event) => setExact(event.target.value)}
              min={localDate(base + 60_000)}
              max={localDate(now + 3650 * day)}
              required
              disabled={disabled}
            />
            <span className={styles.fieldHint}>
              In your browser’s time zone. Must be later than the current expiry
              or now.
            </span>
          </label>
        ) : (
          <>
            <label>
              {extend || approval ? "Add time" : "Access length"}
              <select
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
                disabled={disabled}
              >
                {[7, 14, 30, 90, 365].map((value) => (
                  <option key={value} value={value}>
                    {value} days
                  </option>
                ))}
                <option value="custom">Custom duration</option>
              </select>
            </label>
            {preset === "custom" && (
              <label>
                Number of days
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={customDays}
                  onChange={(event) => setCustomDays(event.target.value)}
                  required
                  disabled={disabled}
                />
              </label>
            )}
          </>
        )}
      </div>
      <div className={styles.preview}>
        <span>New expiry</span>
        {valid ? (
          <time dateTime={new Date(endsAt).toISOString()}>
            {new Date(endsAt).toLocaleString(undefined, {
              dateStyle: "full",
              timeStyle: "long",
            })}
          </time>
        ) : (
          <p>Choose a valid expiry to see a preview.</p>
        )}
        <p>
          {approval
            ? "Grants access and completes this request together."
            : extend
              ? "Adds time after the current expiry or now, whichever is later. Revoked access must be restored separately."
              : "Starts a manual access grant now. Connected Macs stay signed in."}
        </p>
      </div>
      <div className={styles.formFields}>
        {!approval && !extend && (
          <label>
            Admin notes
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={3}
              disabled={disabled}
            />
          </label>
        )}
        <label>
          {approval ? "Admin review note" : "Reason for this change"}
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            rows={2}
            disabled={disabled}
          />
          <span className={styles.fieldHint}>Optional · visible to admins</span>
        </label>
      </div>
      <div className={styles.actions}>
        <Button type="submit" disabled={disabled || !valid}>
          {busy
            ? "Saving…"
            : approval
              ? "Approve and extend"
              : extend
                ? "Extend access"
                : "Grant access"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
