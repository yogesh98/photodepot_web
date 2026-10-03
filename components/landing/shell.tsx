import Link from "next/link"
import Image from "next/image"
import { ArrowUpRight } from "lucide-react"
import type { ReactNode } from "react"
import { LandingWaitlist } from "@/components/landing-waitlist"
import { WaitlistTrigger } from "@/components/waitlist-button"
import styles from "./shell.module.css"

export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <LandingWaitlist>
      <div className={styles.page}>
        <a href="#main" className={styles.skip}>
          Skip to content
        </a>
        <header className={styles.header}>
          <Link
            href="/"
            className={styles.wordmark}
            aria-label="Photodepot home"
          >
            <Image src="/brand/photodepot.png" alt="" width={36} height={36} />
            <span>
              photodepot<span className={styles.period}>.</span>
            </span>
          </Link>
          <WaitlistTrigger
            className={styles.waitlist}
            render={<button type="button" />}
          >
            Join the waitlist <ArrowUpRight size={15} aria-hidden="true" />
          </WaitlistTrigger>
        </header>
        {children}
      </div>
    </LandingWaitlist>
  )
}
