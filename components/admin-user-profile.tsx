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
import type { CustomerRequest } from "@/lib/account-requests"
import type {
  SubscriptionAudit,
  SubscriptionDeviceHistory,
  SubscriptionSummary,
  WorkOSUserSummary,
} from "@/lib/subscription-types"
import styles from "./admin-dashboard.module.css"

export type ProfileDetails = {
  user?: Omit<WorkOSUserSummary, "subscription">
  subscription: SubscriptionSummary | null
  audit: SubscriptionAudit[]
  devices: SubscriptionDeviceHistory[]
  requests?: CustomerRequest[]
}
export function AdminUserProfile({
  user,
  now,
  details,
  loading,
  error,
  actions,
  onBack,
  onRetry,
  onReset,
  onRenewal,
  disabled,
}: {
  user: WorkOSUserSummary
  now: number
  details: ProfileDetails | null
  loading: boolean
  error: string
  actions: ReactNode
  onBack: () => void
  onRetry: () => void
  onReset: (id: string) => void
  onRenewal: () => void
  disabled: boolean
}) {
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
  const sub = user.subscription
  const connectedMacs = details
    ? details.devices.filter((device) => device.current).length
    : (sub?.devices.length ?? 0)
  const date = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })
  const active = sub && sub.status === "active" && sub.endsAt > now
  return (
    <section aria-label="User management" aria-busy={loading}>
      <Button variant="ghost" onClick={onBack} className={styles.backButton}>
        <ArrowLeft />
        Back to users
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
                <h2>Subscription & access</h2>
              </div>
              <ShieldCheck size={19} />
            </div>
            {loading ? (
              <p role="status">Loading subscription and history…</p>
            ) : (
              <>
                <div className={styles.profilePlan}>
                  <strong>
                    {sub
                      ? sub.type === "trial"
                        ? "Trial"
                        : "Standard"
                      : "No subscription"}
                  </strong>
                  <Badge
                    variant="secondary"
                    className={active ? styles.statusActive : ""}
                  >
                    {sub
                      ? active
                        ? "Active"
                        : sub.status === "revoked"
                          ? "Revoked"
                          : "Expired"
                      : "No access"}
                  </Badge>
                </div>
                <dl className={styles.profileFacts}>
                  <div>
                    <dt>Access starts</dt>
                    <dd>{sub ? date(sub.startsAt) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Access ends</dt>
                    <dd>{sub ? date(sub.endsAt) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Renewal preference</dt>
                    <dd>
                      {sub
                        ? sub.cancelAtPeriodEnd
                          ? "Canceled · ends at period end"
                          : "Open to renewal"
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Billing</dt>
                    <dd>Managed manually</dd>
                  </div>
                </dl>
                {sub?.cancelAtPeriodEnd && (
                  <p className={styles.cancellationNote}>
                    Renewal canceled
                    {sub.canceledAt ? ` on ${date(sub.canceledAt)}` : ""}.{" "}
                    {active
                      ? "Access remains active until the end date."
                      : "No future renewal is requested."}
                  </p>
                )}
                <div className={styles.profileActions}>
                  {actions}
                  {sub && active && (
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={onRenewal}
                    >
                      {sub.cancelAtPeriodEnd
                        ? "Resume renewal"
                        : "Cancel renewal"}
                    </Button>
                  )}
                </div>
                <div className={styles.profileNotes}>
                  <h3>Admin notes</h3>
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
                <dt>Last subscription update</dt>
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
                <p>
                  {connectedMacs} of {sub?.deviceLimit ?? 2} slots in use.
                </p>
              </div>
              <Laptop size={18} />
            </div>
            <div className={styles.deviceList}>
              {details?.devices.length ? (
                details.devices.map((device, index) => (
                  <div key={`${device.id}-${device.bindingRevision}`}>
                    <Laptop size={20} />
                    <span>
                      <strong>
                        {device.current ? "Current Mac" : "Previous Mac"}{" "}
                        {index + 1}
                      </strong>
                      <small>Assigned {date(device.activatedAt)}</small>
                      <code title={device.id}>{device.id}</code>
                    </span>
                    {device.current && sub && (
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => onReset(device.id)}
                        aria-label={`Reset Mac ${device.id}`}
                      >
                        Reset this Mac
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
        <Card className={styles.panel}>
          <CardContent>
            <div className={styles.panelHeading}>
              <div>
                <h2>Customer requests</h2>
              </div>
              <Mail size={18} />
            </div>
            <div className={styles.activityList}>
              {details?.requests?.length ? (
                details.requests.map((request) => (
                  <div key={request.id}>
                    <span className={styles.activityDot} />
                    <span>
                      <strong>
                        {request.action === "renewal"
                          ? "Renewal request"
                          : "Mac reset request"}
                      </strong>
                      <small>
                        {date(request.createdAt)} · {request.status}
                      </small>
                      {request.message && <p>{request.message}</p>}
                    </span>
                  </div>
                ))
              ) : (
                <p className={styles.quietText}>
                  {loading
                    ? "Loading requests…"
                    : "No requests from this account."}
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
            {details?.audit.length ? (
              details.audit.map((entry) => (
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
                {loading
                  ? "Loading history…"
                  : "No subscription changes recorded."}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
