import Link from "next/link"
import Image from "next/image"
import { ArrowUpRight } from "lucide-react"
import type { ReactNode } from "react"
import { LandingWaitlist } from "@/components/landing-waitlist"
import { WaitlistTrigger } from "@/components/waitlist-button"
import { LandingScrollArea } from "./scroll-area"
import styles from "./shell.module.css"

export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <LandingWaitlist>
      <LandingScrollArea>
        <a href="#main" className={styles.skip}>
          Skip to content
        </a>
        <header className={styles.header}>
          <Link
            href="/#vision"
            className={styles.wordmark}
            aria-label="Photodepot home"
          >
            <Image
              src="/brand/photodepot-lockup.svg"
              alt=""
              width={625}
              height={169}
              loading="eager"
            />
          </Link>
          <WaitlistTrigger
            className={styles.waitlist}
            render={<button type="button" />}
          >
            Join the waitlist <ArrowUpRight size={15} aria-hidden="true" />
          </WaitlistTrigger>
        </header>
        {children}
      </LandingScrollArea>
    </LandingWaitlist>
  )
}
