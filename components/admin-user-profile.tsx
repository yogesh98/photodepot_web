"use client"

import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Laptop,
  Mail,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import type { ReactNode } from "react"
import type {
  SubscriptionAudit,
  AccountDevice,
  AccountDeviceHistory,
  AccountAccess,
  SubscriptionSummary,
  WorkOSUserSummary,
} from "@/lib/subscription-types"
import styles from "./admin-dashboard.module.css"

export type ProfileDetails = {
  user: WorkOSUserSummary
  subscription: SubscriptionSummary | null
  audit: SubscriptionAudit[]
  deviceAudit: {
    id: string
    sessionId: string
    action: string
    actor: string
    createdAt: number
    reason: string
  }[]
  devices: AccountDeviceHistory[]
  access: AccountAccess
}
export function AdminUserProfile({
  user,
  details,
  loading,
  error,
  actions,
  onBack,
  onRetry,
  onRemove,
  disabled,
}: {
  user: WorkOSUserSummary
  details: ProfileDetails | null
  loading: boolean
  error: string
  actions: ReactNode
  onBack: () => void
  onRetry: () => void
  onRemove: (device: AccountDevice) => void
  disabled: boolean
}) {
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
  const sub = user.subscription
  const connectedMacs = details
    ? details.devices.filter((device) => device.current).length
    : user.devices.length
  const date = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })
  const history = details
    ? [
        ...details.audit,
        ...details.deviceAudit.map((entry) => ({
          ...entry,
          id: `device-${entry.id}`,
          detail: `Removed ${details.devices.find((device) => device.sessionId === entry.sessionId)?.deviceName || "Mac"} from account`,
        })),
      ]
        .sort(
          (left, right) =>
            right.createdAt - left.createdAt || right.id.localeCompare(left.id)
        )
        .slice(0, 100)
    : []
  const active = !user.accessUnavailable && user.access.canUseLocal
  return (
    <section aria-label="User management" aria-busy={loading}>
      <Button variant="ghost" onClick={onBack} className={styles.backButton}>
        <ArrowLeft />
        Back to accounts
      </Button>
      <div className={styles.profileHeading}>
        <span className={styles.largeAvatar}>
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h2>{name}</h2>
          <p>{user.email}</p>
        </div>
        <Badge variant="outline">
          {user.emailVerified ? <CheckCircle2 size={12} /> : <Mail size={12} />}{" "}
          {user.emailVerified ? "Verified email" : "Email unverified"}
        </Badge>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}{" "}
          <Button variant="outline" onClick={onRetry}>
            Retry details
          </Button>
        </p>
      )}
      <div className={styles.profileGrid}>
        <Card className={styles.panel}>
          <CardContent>
            <div className={styles.panelHeading}>
              <div>
                <h2>Access</h2>
              </div>
              <ShieldCheck size={19} />
            </div>
            {loading ? (
              <p role="status">Loading access and history…</p>
            ) : (
              <>
                <div className={styles.profilePlan}>
                  <strong>
                    {user.accessUnavailable
                      ? "Access unavailable"
                      : user.access.tier === "trial"
                        ? "Trial"
                        : user.access.tier === "standard"
                          ? "Standard"
                          : "Free account"}
                  </strong>
                  <Badge
                    variant="secondary"
                    className={active ? styles.statusActive : ""}
                  >
                    {user.accessUnavailable
                      ? "Unavailable"
                      : user.access.status === "active"
                        ? "Active"
                        : user.access.status === "revoked"
                          ? "Revoked"
                          : user.access.status === "expired"
                            ? "Expired"
                            : "Free account"}
                  </Badge>
                </div>
                {user.accessUnavailable && (
                  <p role="status">
                    We couldn’t check subscription access. You can still manage
                    this account’s devices and view its history. Refresh to try
                    again.
                  </p>
                )}
                <dl className={styles.profileFacts}>
                  <div>
                    <dt>
                      {user.access.source === "workos"
                        ? "Access checked"
                        : "Access starts"}
                    </dt>
                    <dd>
                      {!user.accessUnavailable && user.access.startsAt != null
                        ? date(user.access.startsAt)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {user.access.source === "workos"
                        ? "Offline access valid until"
                        : "Access ends"}
                    </dt>
                    <dd>
                      {!user.accessUnavailable && user.access.endsAt != null
                        ? date(user.access.endsAt)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Access source</dt>
                    <dd>
                      {user.accessUnavailable
                        ? "Unavailable"
                        : user.access.source === "workos"
                          ? "WorkOS subscription access"
                          : "Free account"}
                    </dd>
                  </div>
                </dl>
                <div className={styles.profileActions}>{actions}</div>
                <div className={styles.profileNotes}>
                  <h3>Historical admin notes</h3>
                  <p>{sub?.notes || "No notes."}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card className={styles.panel}>
          <CardContent>
            <div className={styles.panelHeading}>
              <div>
                <h2>Account details</h2>
              </div>
              <Mail size={18} />
            </div>
            <dl className={styles.profileFacts}>
              <div>
                <dt>Email address</dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt>Joined Photodepot</dt>
                <dd>{date(user.createdAt)}</dd>
              </div>
              <div>
                <dt>User ID</dt>
                <dd className={styles.mono}>{user.id}</dd>
              </div>
              <div>
                <dt>Last access update</dt>
                <dd>{sub ? date(sub.updatedAt) : "—"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card className={styles.panel}>
          <CardContent>
            <div className={styles.panelHeading}>
              <div>
                <h2>Connected Macs</h2>
                <p>{connectedMacs} of 2 slots in use.</p>
              </div>
              <Laptop size={18} />
            </div>
            <div className={styles.deviceList}>
              {details?.devices.length ? (
                details.devices.map((device, index) => (
                  <div key={device.sessionId}>
                    <Laptop size={20} />
                    <span>
                      <strong>
                        {device.deviceName ||
                          `${device.current ? "Connected" : "Previous"} Mac ${index + 1}`}
                      </strong>
                      <small>
                        Connected {date(device.activatedAt)}
                        {device.lastUsedAt != null && (
                          <> · Last used {date(device.lastUsedAt)}</>
                        )}
                      </small>
                      <code title={device.id}>{device.id}</code>
                    </span>
                    {device.current && (
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => onRemove(device)}
                        aria-label={`Remove ${device.deviceName || "Mac"}`}
                      >
                        Remove Mac
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <p className={styles.quietText}>
                  {loading ? "Loading devices…" : "No Mac has been assigned."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className={styles.panel}>
        <CardContent>
          <div className={styles.panelHeading}>
            <div>
              <h2>Activity history</h2>
              <p>Latest 100 changes</p>
            </div>
            <Clock3 size={18} />
          </div>
          <div className={styles.activityList}>
            {history.length ? (
              history.map((entry) => (
                <div key={entry.id}>
                  <span className={styles.activityDot} />
                  <span>
                    <strong>{entry.detail}</strong>
                    <small>
                      {date(entry.createdAt)} · {entry.actor}
                    </small>
                    {entry.reason && <p>{entry.reason}</p>}
                  </span>
                </div>
              ))
            ) : (
              <p className={styles.quietText}>
                {loading ? "Loading history…" : "No changes recorded."}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
