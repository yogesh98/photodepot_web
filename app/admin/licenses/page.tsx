import type { Metadata } from "next"
import { SubscriptionDashboard } from "@/components/subscription-dashboard"
export const metadata: Metadata = {
  title: "Subscriptions · Photodepot",
  robots: { index: false, follow: false },
}
export default function Page() {
  return <SubscriptionDashboard />
}
