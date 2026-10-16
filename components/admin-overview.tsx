"use client"

import { ArrowRight, CircleCheck, CreditCard, Users } from "lucide-react"
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
      title: "Active access",
      value: overview?.active,
      text: "Verified subscription access",
      icon: CircleCheck,
      filter: "active",
      tone: "green",
    },
    {
      title: "Connected Macs",
      value: overview?.assignedMacs,
      text: "Across all accounts",
      icon: Users,
      filter: "all",
      tone: "orange",
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
      label: "Active subscriptions",
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
                      filter === "waitlist" ? "waitlist" : "accounts",
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
                <h2>Access overview</h2>
              </div>
              <CreditCard size={18} />
            </div>
            <div className={styles.healthTotal}>
              <strong>{overview ? total : "—"}</strong>
              <span>subscription access records</span>
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
                  onClick={() => navigate("accounts", stage.filter)}
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
      </div>
    </>
  )
}
