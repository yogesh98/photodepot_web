import Image from "next/image"
import { FolderTree, HardDrive, Scan, Send, Users } from "lucide-react"
import {
  LandingWaitlist,
  LandingWaitlistTrigger,
} from "@/components/landing-waitlist"
import { Reveal } from "@/components/reveal"

const workflow = [
  {
    number: "01",
    title: "Ingest",
    icon: HardDrive,
    color: "amber",
    description:
      "Bring in cards and drives. Copies are verified, duplicates are skipped, and originals stay untouched.",
  },
  {
    number: "02",
    title: "Cull",
    icon: Scan,
    color: "blue",
    description:
      "Compare frames, look closer, and find your keepers with picks, rejects, and star ratings.",
  },
  {
    number: "03",
    title: "Organize",
    icon: FolderTree,
    color: "cyan",
    description:
      "Give your selection a structure. Arrange folders, add tags, and prepare the final layout.",
  },
  {
    number: "04",
    title: "Export",
    icon: Send,
    color: "stone",
    description:
      "Review the plan, choose a destination, and export your organized media with XMP sidecars.",
  },
]

export default function Page() {
  return (
    <LandingWaitlist>
      <div className="landing-page">
        <header className="landing-header landing-container">
          <div className="wordmark" aria-label="photodepot">
            <Image src="/brand/photodepot.png" alt="" width={36} height={36} />
            <span>
              photodepot<span className="wordmark-period">.</span>
            </span>
          </div>
          <LandingWaitlistTrigger appearance="quiet" />
        </header>

        <main>
          <section
            className="landing-hero landing-container"
            aria-labelledby="hero-title"
          >
            <Reveal className="hero-copy">
              <h1 id="hero-title">
                Shoot together.
                <br />
                <span className="hero-highlight">Cull together.</span>
              </h1>
              <p className="hero-description">
                Ingest, cull, organize as a team
              </p>
              <LandingWaitlistTrigger />
            </Reveal>

            <Reveal className="hero-product" delay={0.12}>
              <figure>
                <div className="product-mat">
                  <div className="mat-colors" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="app-window">
                    <Image
                      className="app-screenshot hero-screenshot"
                      src="/screenshots/cull.png"
                      alt="PhotoDepot’s Cull workspace with coastal photos, a large image preview, and tools for picks and star ratings."
                      width={2560}
                      height={1680}
                      sizes="(max-width: 760px) 100vw, (max-width: 1280px) 90vw, 1120px"
                      preload
                    />
                  </div>
                </div>
              </figure>
            </Reveal>
          </section>

          <section
            className="workflow-section landing-container"
            aria-labelledby="workflow-title"
          >
            <Reveal className="section-intro">
              <p className="landing-eyebrow">The workflow</p>
              <h2 id="workflow-title">From import to export.</h2>
            </Reveal>
            <div className="workflow-grid">
              {workflow.map(
                ({ number, title, icon: Icon, color, description }, index) => (
                  <Reveal
                    key={title}
                    className={`workflow-step step-${color}`}
                    delay={index * 0.06}
                  >
                    <div className="step-topline">
                      <span className="step-number">{number}</span>
                      <Icon size={19} strokeWidth={1.5} aria-hidden="true" />
                    </div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </Reveal>
                )
              )}
            </div>

            <div className="workspace-pair">
              <Reveal>
                <figure>
                  <div className="workspace-frame workspace-ingest">
                    <div className="app-window">
                      <Image
                        className="app-screenshot"
                        src="/screenshots/ingest.png"
                        alt="PhotoDepot’s Ingest workspace showing six verified coastal photos and a completed, checked camera-card ingest."
                        width={2560}
                        height={1680}
                        sizes="(max-width: 760px) 90vw, (max-width: 1280px) 45vw, 550px"
                      />
                    </div>
                  </div>
                  <figcaption className="workspace-caption">
                    Ingest · Bring every source into the project.
                  </figcaption>
                </figure>
              </Reveal>
              <Reveal delay={0.08}>
                <figure>
                  <div className="workspace-frame workspace-organize">
                    <div className="app-window">
                      <Image
                        className="app-screenshot"
                        src="/screenshots/organize.png"
                        alt="PhotoDepot’s Organize workspace with a folder tree, photo selection, and tags."
                        width={2560}
                        height={1680}
                        sizes="(max-width: 760px) 90vw, (max-width: 1280px) 45vw, 550px"
                      />
                    </div>
                  </div>
                  <figcaption className="workspace-caption">
                    Organize · Shape the selection before export.
                  </figcaption>
                </figure>
              </Reveal>
            </div>
          </section>

          <section
            className="collaboration-section landing-container"
            aria-labelledby="collaboration-title"
          >
            <Reveal className="collaboration-copy">
              <p className="landing-eyebrow">
                <Users size={14} strokeWidth={1.5} aria-hidden="true" />{" "}
                Collaboration
              </p>
              <h2 id="collaboration-title">
                Review together.
                <br />
                On the same network.
              </h2>
              <p className="section-description">
                One Mac hosts the project. Approved reviewers can cull and
                organize from their own Macs, with changes shared across the
                project.
              </p>
              <p className="collaboration-detail">
                You approve who joins. Ingest and export stay with the host.
              </p>
            </Reveal>
            <Reveal className="collaboration-visual" delay={0.08}>
              <div
                className="network-diagram"
                role="img"
                aria-label="One Mac hosts the project and approves reviewers. Reviewers on the same local network can cull and organize together."
              >
                <div className="network-host">
                  <Image
                    src="/brand/photodepot.png"
                    alt=""
                    width={44}
                    height={44}
                  />
                  <div>
                    <strong>Your project</strong>
                    <span>Hosted on your Mac</span>
                  </div>
                  <span className="host-label">Host</span>
                </div>
                <div className="network-connections" aria-hidden="true">
                  <span />
                  <span />
                </div>
                <div className="network-reviewers">
                  <div className="network-reviewer reviewer-blue">
                    <div className="reviewer-mark">
                      <Users size={20} strokeWidth={1.4} />
                    </div>
                    <strong>Reviewer</strong>
                    <span>Cull &amp; organize</span>
                  </div>
                  <div className="network-reviewer reviewer-cyan">
                    <div className="reviewer-mark">
                      <Users size={20} strokeWidth={1.4} />
                    </div>
                    <strong>Reviewer</strong>
                    <span>Cull &amp; organize</span>
                  </div>
                </div>
              </div>
            </Reveal>
          </section>

          <section
            className="landing-waitlist-section landing-container"
            aria-labelledby="waitlist-title"
          >
            <Reveal>
              <div className="closing-colors" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <h2 id="waitlist-title">PhotoDepot is in development.</h2>
              <p>Join the waitlist for news and availability.</p>
              <LandingWaitlistTrigger />
            </Reveal>
          </section>
        </main>
        <footer className="landing-footer landing-container">
          <span>photodepot.</span>
        </footer>
      </div>
    </LandingWaitlist>
  )
}
