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
            aria-label="PhotoDepot home"
          >
            <Image src="/brand/photodepot.png" alt="" width={36} height={36} />
            <span>
              photodepot<span className={styles.period}>.</span>
            </span>
          </Link>
          <nav className={styles.navigation} aria-label="Main navigation">
            <a href="#philosophy">Why PhotoDepot</a>
            <a href="#collaboration">Collaboration</a>
            <a href="#workflow">The workflow</a>
          </nav>
          <WaitlistTrigger
            className={styles.waitlist}
            render={<button type="button" />}
          >
            Join the waitlist <ArrowUpRight size={15} aria-hidden="true" />
          </WaitlistTrigger>
        </header>
        <main id="main">{children}</main>
      </div>
    </LandingWaitlist>
  )
}
