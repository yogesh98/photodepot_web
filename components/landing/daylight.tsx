"use client"

import Image from "next/image"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Wifi,
} from "lucide-react"
import { useRef, useState } from "react"
import { LandingWaitlistTrigger } from "@/components/landing-waitlist"
import { photographs } from "./photography"
import styles from "./daylight.module.css"

const pairs = [
  [0, 1],
  [3, 4],
  [5, 6],
]
const workflow = [
  {
    name: "Ingest",
    text: "Bring your photographs home on the host Mac. Copy from your cards, verify your files, and keep your originals intact.",
    image: "ingest",
  },
  {
    name: "Cull",
    text: "Follow your instincts, together. Compare frames and flag the keepers with approved reviewers on your local network.",
    image: "cull",
  },
  {
    name: "Organize",
    text: "Give a shared project its shape. Use folders, tags, and ratings to bring your photographs into focus together.",
    image: "organize",
  },
  {
    name: "Export",
    text: "Take your selection forward. Export your chosen photographs and XMP sidecars from the host Mac for the next part of your process.",
    image: "organize",
  },
]

export function DaylightLanding() {
  const heroRef = useRef<HTMLElement>(null)
  const imageRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const [pair, setPair] = useState(0)
  const [selectedPhoto, setSelectedPhoto] = useState(5)
  const [stage, setStage] = useState(1)
  const { scrollYProgress: heroProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  })
  const { scrollYProgress: imageProgress } = useScroll({
    target: imageRef,
    offset: ["start end", "center center"],
  })
  const heroY = useTransform(heroProgress, [0, 1], [0, 110])
  const photoMask = useTransform(
    imageProgress,
    [0, 1],
    ["inset(10% 12% 10% 12%)", "inset(0% 0% 0% 0%)"]
  )
  const selected = photographs[selectedPhoto]
  const activeStage = workflow[stage]

  return (
    <div className={styles.page}>
      <section
        ref={heroRef}
        className={styles.hero}
        aria-labelledby="daylight-title"
      >
        <div className={styles.heroMeta}>
          <span>
            <i /> A workspace for you and your team
          </span>
          <span>In development / For Mac</span>
        </div>
        <motion.div
          className={styles.heroPhotos}
          style={{ y: reducedMotion ? 0 : heroY }}
        >
          <AnimatePresence initial={false}>
            <motion.div
              className={styles.photoPair}
              key={pair}
              initial={{
                clipPath: reducedMotion
                  ? "inset(0 0 0 0)"
                  : "inset(0 0 100% 0)",
              }}
              animate={{ clipPath: "inset(0 0 0% 0)" }}
              exit={{ opacity: 0 }}
              transition={{
                duration: reducedMotion ? 0 : 0.85,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {pairs[pair].map((photoIndex, index) => {
                const photo = photographs[photoIndex]
                return (
                  <div
                    className={styles.heroPanel}
                    key={photo.id}
                    data-panel={index}
                  >
                    <Image
                      src={photo.src}
                      alt={photo.alt}
                      fill
                      sizes={
                        photoIndex < 2
                          ? "(max-width: 700px) 170vw, 70vw"
                          : "(max-width: 700px) 75vw, 45vw"
                      }
                      preload={pair === 0}
                      style={{ objectPosition: photo.position }}
                    />
                    <span className={styles.panelLabel}>
                      {photo.label} / 0{photoIndex + 1}
                    </span>
                  </div>
                )
              })}
            </motion.div>
          </AnimatePresence>
        </motion.div>
        <div className={styles.heroCopy}>
          <p className={styles.sectionLabel}>Your vision. In focus.</p>
          <h1 id="daylight-title">
            <span>TRUST</span>
            <span>YOUR</span>
            <span>
              EYE<span className={styles.orange}>.</span>
            </span>
          </h1>
        </div>
        <div className={styles.heroBottom}>
          <div className={styles.heroIntro}>
            <p>
              Make the cut together, from your own Macs.
              <br />
              One project. The same local network.
            </p>
            <div className={styles.cta}>
              <LandingWaitlistTrigger />
            </div>
          </div>
          <div
            className={styles.heroControls}
            aria-label="Featured photography controls"
          >
            <span className={styles.counter} aria-live="polite">
              0{pair + 1}
              <span> / 03</span>
            </span>
            <button
              type="button"
              onClick={() => setPair((pair + pairs.length - 1) % pairs.length)}
              aria-label="Previous photograph pair"
            >
              <ArrowLeft size={19} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setPair((pair + 1) % pairs.length)}
              aria-label="Next photograph pair"
            >
              <ArrowRight size={19} aria-hidden="true" />
            </button>
            <a
              href="#philosophy"
              className={styles.exploreLink}
              aria-label="Explore the collection"
            >
              <ArrowDown size={19} aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      <section
        id="philosophy"
        className={styles.collection}
        aria-labelledby="daylight-philosophy-title"
      >
        <div className={styles.sectionTopline}>
          <span>01 / A way of seeing</span>
          <span>Every kind of photographer</span>
        </div>
        <div className={styles.collectionIntro}>
          <h2 id="daylight-philosophy-title">
            IT STARTS
            <br />
            WITH A FEELING.
          </h2>
          <p>
            A face. A gesture. An unexpected shape in the everyday. You know
            when a photograph has something. Bring trusted eyes into the
            selection, and build a body of work together with PhotoDepot.
          </p>
        </div>
        <div
          className={styles.photoNavigation}
          aria-label="Explore photography subjects"
        >
          {photographs.map((photo, index) => (
            <button
              key={photo.id}
              type="button"
              aria-pressed={selectedPhoto === index}
              onClick={() => setSelectedPhoto(index)}
            >
              <span>0{index + 1}</span>
              {photo.label}
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div ref={imageRef} className={styles.featuredOuter}>
          <motion.div
            className={styles.featuredPhoto}
            style={{ clipPath: reducedMotion ? undefined : photoMask }}
          >
            <AnimatePresence initial={false}>
              <motion.div
                key={selected.id}
                className={styles.featuredLayer}
                initial={{
                  clipPath: reducedMotion
                    ? "inset(0 0 0 0)"
                    : "inset(0 0 0 100%)",
                }}
                animate={{ clipPath: "inset(0 0 0 0%)" }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: reducedMotion ? 0 : 0.7,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <Image
                  src={selected.src}
                  alt={selected.alt}
                  fill
                  sizes="(max-width: 700px) 100vw, 92vw"
                  style={{ objectPosition: selected.position }}
                />
              </motion.div>
            </AnimatePresence>
            <div className={styles.featuredOverlay} aria-hidden="true">
              <span>
                LOOK
                <br />
                CLOSER.
              </span>
              <ArrowUpRight />
            </div>
          </motion.div>
        </div>
        <div className={styles.featuredCaption} aria-live="polite">
          <span>Selected study / {selected.label}</span>
          <a href={selected.source} target="_blank" rel="noreferrer">
            {selected.photographer} / Pexels ↗
          </a>
        </div>
      </section>

      <section
        id="workflow"
        className={styles.workflow}
        aria-labelledby="daylight-workflow-title"
      >
        <div className={styles.sectionTopline}>
          <span>02 / Behind the photographs</span>
          <span>PhotoDepot for Mac</span>
        </div>
        <div className={styles.workflowHeading}>
          <h2 id="daylight-workflow-title">
            THE WORK
            <br />
            AFTER THE WORK.
          </h2>
          <p>
            From the first import to the final selection. A considered workflow
            with room for the people whose eye you trust.
          </p>
        </div>
        <div className={styles.workflowGrid}>
          <div
            className={styles.steps}
            aria-label="Explore the PhotoDepot workflow"
          >
            {workflow.map((item, index) => (
              <button
                type="button"
                key={item.name}
                aria-pressed={stage === index}
                onClick={() => setStage(index)}
              >
                <span className={styles.stepNumber}>0{index + 1}</span>
                <span className={styles.stepContent}>
                  <span className={styles.stepName}>{item.name}</span>
                  {stage === index && (
                    <span className={styles.stepDescription}>{item.text}</span>
                  )}
                </span>
                <ArrowUpRight size={22} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className={styles.product}>
            <div className={styles.productTop}>
              <span>
                <i /> A look inside PhotoDepot
              </span>
              <span>{activeStage.name}</span>
            </div>
            <div className={styles.productImage}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeStage.name}
                  initial={{ opacity: reducedMotion ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: reducedMotion ? 1 : 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.18 }}
                >
                  <Image
                    src={`/screenshots/${activeStage.image}.png`}
                    alt={`PhotoDepot ${activeStage.image} workspace showing photo thumbnails and selection tools`}
                    width={2560}
                    height={1600}
                    sizes="(max-width: 850px) 92vw, 54vw"
                  />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className={styles.reviewNote}>
              <Wifi size={19} aria-hidden="true" />
              <p>
                <strong>Your own Macs. A shared project.</strong> Cull and
                organize together on the same local network.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="collaboration"
        className={styles.collaboration}
        aria-labelledby="daylight-collaboration-title"
      >
        <div className={styles.sectionTopline}>
          <span>03 / A shared perspective</span>
          <span>Same local network</span>
        </div>
        <div className={styles.collaborationHeading}>
          <h2 id="daylight-collaboration-title">
            MORE EYES.
            <br />
            ONE VISION.
          </h2>
          <p>
            The edit gets better with people you trust. Invite your team to cull
            and organize the same project, each from their own Mac.
          </p>
        </div>
        <ol className={styles.collaborationSteps}>
          <li>
            <span className={styles.collaborationNumber}>01</span>
            <h3>One Mac hosts.</h3>
            <p>
              Open the project on a host Mac. Ingest and export stay with the
              host.
            </p>
          </li>
          <li>
            <span className={styles.collaborationNumber}>02</span>
            <h3>Bring your team in.</h3>
            <p>
              Reviewers join from their own Macs on the same local network. The
              host approves access.
            </p>
          </li>
          <li>
            <span className={styles.collaborationNumber}>03</span>
            <h3>Make the cut together.</h3>
            <p>
              Cull and organize with a shared view of the work. Changes are
              shared across the project.
            </p>
          </li>
        </ol>
      </section>

      <section
        className={styles.closing}
        aria-labelledby="daylight-closing-title"
      >
        <div className={styles.closingTop}>
          <span>04 / Make room for your next collaboration</span>
          <span>In development</span>
        </div>
        <div className={styles.closingBody}>
          <h2 id="daylight-closing-title">
            GOOD WORK.
            <br />
            WHAT&apos;S NEXT?
          </h2>
          <ArrowUpRight
            className={styles.closingArrow}
            strokeWidth={0.8}
            aria-hidden="true"
          />
        </div>
        <div className={styles.closingBottom}>
          <p>
            Bring your next body of work together.
            <br />
            Join the waitlist for news and early access.
          </p>
          <div className={styles.closingCta}>
            <LandingWaitlistTrigger />
          </div>
          <span>
            Made for your eye.
            <br />
            Built for your Mac.
          </span>
        </div>
      </section>
    </div>
  )
}
