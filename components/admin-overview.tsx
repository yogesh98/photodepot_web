"use client"

import {
  ArrowDownRight,
  ArrowRight,
  CircleCheck,
  Clock3,
  CreditCard,
  Mail,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { SubscriptionOverview } from "@/lib/subscription-types"
import styles from "./admin-dashboard.module.css"

export function AdminOverview({
  overview,
  navigate,
}: {
  overview: SubscriptionOverview | null
  navigate: (view: string, filter?: string) => void
}) {
  const metrics = [
    {
      title: "Active subscriptions",
      value: overview?.active,
      text: `${overview?.activeTrials ?? 0} trial · ${overview?.activeStandard ?? 0} standard`,
      icon: CircleCheck,
      filter: "active",
      tone: "green",
    },
    {
      title: "Renewal canceled",
      value: overview?.canceling,
      text: "Active until expiry",
      icon: ArrowDownRight,
      filter: "canceling",
      tone: "orange",
    },
    {
      title: "Expiring this week",
      value: overview?.expiringSoon,
      text: null,
      icon: Clock3,
      filter: "expiring",
      tone: "blue",
    },
    {
      title: "Waitlist signups",
      value: overview?.waitlistTotal,
      text: `${overview?.waitlistLast30Days ?? 0} joined in the last 30 days`,
      icon: Users,
      filter: "waitlist",
      tone: "purple",
    },
  ]
  const total = overview?.totalSubscriptions ?? 0
  const stages = [
    {
      label: "Active trials",
      count: overview?.activeTrials ?? 0,
      color: "var(--chart-1)",
      filter: "trial",
    },
    {
      label: "Active standard",
      count: overview?.activeStandard ?? 0,
      color: "var(--chart-2)",
      filter: "standard",
    },
    {
      label: "Expired",
      count: overview?.expired ?? 0,
      color: "var(--chart-3)",
      filter: "expired",
    },
    {
      label: "Revoked",
      count: overview?.revoked ?? 0,
      color: "var(--chart-4)",
      filter: "revoked",
    },
  ]
  return (
    <>
      <div className={styles.metrics}>
        {metrics.map(({ title, value, text, icon: Icon, filter, tone }) => (
          <Card key={title} className={styles.metric}>
            <CardContent>
              <div className={styles.metricLabel}>
                <span>{title}</span>
                <Icon className={styles[tone]} size={17} />
              </div>
              <div className={styles.metricValue}>{value ?? "—"}</div>
              <div className={styles.metricFoot}>
                {text && <span>{text}</span>}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`View ${title.toLowerCase()}`}
                  onClick={() =>
                    navigate(
                      filter === "waitlist" ? "waitlist" : "subscriptions",
                      filter === "waitlist" ? "all" : filter
                    )
                  }
                >
                  <ArrowRight />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className={styles.overviewGrid}>
        <Card className={styles.panel}>
          <CardContent>
            <div className={styles.panelHeading}>
              <div>
                <h2>Subscription health</h2>
              </div>
              <CreditCard size={18} />
            </div>
            <div className={styles.healthTotal}>
              <strong>{overview ? total : "—"}</strong>
              <span>total subscriptions</span>
            </div>
            <div
              className={styles.healthBar}
              role="img"
              aria-label={stages
                .map((s) => `${s.label}: ${s.count}`)
                .join(", ")}
            >
              {stages.map(
                (stage) =>
                  stage.count > 0 && (
                    <span
                      key={stage.label}
                      style={{
                        width: `${(stage.count / Math.max(total, 1)) * 100}%`,
                        background: stage.color,
                      }}
                    />
                  )
              )}
            </div>
            <div className={styles.healthLegend}>
              {stages.map((stage) => (
                <button
                  key={stage.label}
                  onClick={() => navigate("subscriptions", stage.filter)}
                >
                  <span>
                    <i style={{ background: stage.color }} />
                    {stage.label}
                  </span>
                  <strong>{overview ? stage.count : "—"}</strong>
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card className={styles.panel}>
          <CardContent>
            <div className={styles.panelHeading}>
              <div>
                <h2>Needs your attention</h2>
              </div>
              <span className={styles.liveDot} />
            </div>
            <div className={styles.attentionList}>
              <button onClick={() => navigate("operations")}>
                <span className={styles.attentionIcon}>
                  <Mail size={17} />
                </span>
                <span>
                  <strong>Customer requests</strong>
                </span>
                <b>{overview?.openRequests ?? "—"}</b>
                <ArrowRight size={15} />
              </button>
              <button onClick={() => navigate("subscriptions", "canceling")}>
                <span className={styles.attentionIcon}>
                  <ArrowDownRight size={17} />
                </span>
                <span>
                  <strong>Renewal canceled</strong>
                </span>
                <b>{overview?.canceling ?? "—"}</b>
                <ArrowRight size={15} />
              </button>
              <button onClick={() => navigate("subscriptions", "expiring")}>
                <span className={styles.attentionIcon}>
                  <Clock3 size={17} />
                </span>
                <span>
                  <strong>Upcoming expirations</strong>
                </span>
                <b>{overview?.expiringSoon ?? "—"}</b>
                <ArrowRight size={15} />
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
