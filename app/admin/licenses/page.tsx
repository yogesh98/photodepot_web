import type { Metadata } from "next"
import { LicenseDashboard } from "@/components/license-dashboard"
export const metadata: Metadata = {
  title: "Licenses · Photodepot",
  robots: { index: false, follow: false },
}
export default function Page() {
  return <LicenseDashboard />
}
