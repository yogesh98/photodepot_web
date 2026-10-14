import type { Metadata } from "next"
import { CustomerAccountPage } from "@/components/customer-account"

export const metadata: Metadata = {
  title: "Your account · Photodepot",
  robots: { index: false, follow: false },
}
export default function Page() {
  return <CustomerAccountPage />
}
