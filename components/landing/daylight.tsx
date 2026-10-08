"use client"

import Image from "next/image"
import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from "framer-motion"
import { ArrowDown, ArrowUpRight, UsersRound } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { LandingWaitlistTrigger } from "@/components/landing-waitlist"
import { LandingSections } from "./sections"
import { collaborationPhotograph, photographs } from "./photography"
import demoAssets from "./demo-assets.json"
import {
  preloadDemoVideo,
  prefersSaveData,
  useDemoReducedMotion,
  warmDemoVideo,
} from "./demo-media-loading"
import styles from "./daylight.module.css"

type ProductDemo = {
  video: string
  poster: string
  alt: string
}

function DemoMedia({
  demo,
  sizes,
  id,
}: {
  demo: ProductDemo
  sizes: string
  id?: string
}) {
  const mediaRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const visible = useInView(mediaRef, { amount: 0.1 })
  const nearby = useInView(mediaRef, { margin: "800px 0px", once: true })
  const reducedMotion = useDemoReducedMotion()
  const [loadedVideo, setLoadedVideo] = useState<{
    source: string
    url: string
  } | null>(null)
  const videoUrl =
    loadedVideo?.source === demo.video ? loadedVideo.url : undefined
  const playVideo = visible && !reducedMotion && Boolean(videoUrl)

  useEffect(() => {
    if (!nearby || reducedMotion || (!visible && prefersSaveData())) return

    let cancelled = false
    void preloadDemoVideo(demo.video, visible ? "auto" : "low").then((url) => {
      if (url && !cancelled) setLoadedVideo({ source: demo.video, url })
    })
    return () => {
      cancelled = true
    }
  }, [demo.video, nearby, reducedMotion, visible])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (playVideo) void video.play().catch(() => {})
    else video.pause()
  }, [playVideo, videoUrl])

  return (
    <div
      ref={mediaRef}
      id={id}
      className={styles.demoMedia}
      role="img"
      aria-label={demo.alt}
    >
      <picture>
        <Image
          src={demo.poster}
          alt=""
          width={960}
          height={600}
          sizes={sizes}
          loading="lazy"
          unoptimized
        />
      </picture>
      <video
        key={demo.video}
        ref={videoRef}
        className={styles.demoVideo}
        src={videoUrl}
        poster={demo.poster}
        muted
        loop
        playsInline
        autoPlay={playVideo}
        preload="auto"
        aria-hidden="true"
        style={{ visibility: playVideo ? "visible" : "hidden" }}
      />
    </div>
  )
}

const aiFeatures = [
  {
    id: "stacks",
    label: "Similar stacks",
    title: "Related frames, together.",
    text: "Photodepot compares how your photos look and when they were taken to group related frames into stacks. Review a burst or repeated composition together, instead of one file at a time.",
    ...demoAssets["ai-stacks"],
    alt: "Photodepot’s wedding photographs grouped into related stacks.",
  },
  {
    id: "ranking",
    label: "Face / Eye analysis",
    title: "A little help finding the keepers.",
    text: "Face analysis estimates whether eyes are open or closed. Together with sharpness and exposure checks, it helps rank the photos in each stack so you have a useful place to start.",
    ...demoAssets["ai-ranking"],
    alt: "Photodepot’s Close-ups panel highlighting possible closed eyes in a wedding photograph.",
  },
  {
    id: "local",
    label: "On your Mac",
    title: "Your photos stay with you.",
    text: "The AI model comes bundled with Photodepot and runs offline on your Mac. Analysis happens locally, without uploading your photographs to a cloud AI service.",
    ...demoAssets["ai-local"],
    alt: "Photodepot’s local Cull settings showing settings saved on this Mac and cached analysis.",
  },
]

const workflow = [
  {
    name: "Ingest",
    text: "easily ingest multiple cards throughout the day without missing a beat. Photodepot helps you keep track of ingests and transfers faster and more reliably than your file explorer",
    ...demoAssets["workflow-ingest"],
    alt: "Photodepot’s light-mode ingest workspace showing a connected wedding card, selected photos, and the transfer queue.",
  },
  {
    name: "Cull",
    text: "Cull with AI assistance and review together with your team, seamlessly connect over your local network. Tag, Rate, and Flag your photos",
    ...demoAssets["workflow-cull"],
    alt: "Photodepot’s light-mode culling workspace showing photo comparisons, face close-ups, and rating controls.",
  },
  {
    name: "Organize",
    text: "Give your project its shape. Organize quickly, without waiting for your disk to catch up.",
    ...demoAssets["workflow-organize"],
    alt: "Photodepot’s light-mode organize workspace showing selected photos, tags, and the project’s folder structure.",
  },
  {
    name: "Export",
    text: "Take your project to the archives. Export your assets into your chosen structure and leave the clutter behind.",
    ...demoAssets["workflow-export"],
    alt: "Photodepot’s light-mode export workspace showing the destination, organized photo counts, and Export copy action.",
  },
]

export function DaylightLanding({
  heroPhotoIndices,
}: {
  heroPhotoIndices: number[]
}) {
  const reducedMotion = useReducedMotion()
  const [selectedFeature, setSelectedFeature] = useState(0)
  const [stage, setStage] = useState(0)
  const feature = aiFeatures[selectedFeature]
  const activeStage = workflow[stage]
  const workflowRef = useRef<HTMLElement>(null)
  const workflowVisible = useInView(workflowRef, { amount: 0.1 })

  useEffect(() => {
    // Hidden carousel slides are clipped, so viewport margins cannot warm them.
    // Give the first demo a head start after the hero has finished loading.
    const warmFirstDemo = () => warmDemoVideo(workflow[0].video)
    if (document.readyState === "complete") warmFirstDemo()
    else window.addEventListener("load", warmFirstDemo, { once: true })
    return () => window.removeEventListener("load", warmFirstDemo)
  }, [])

  useEffect(() => {
    if (workflowVisible) warmDemoVideo(aiFeatures[0].video)
  }, [workflowVisible])

  return (
    <LandingSections className={styles.page}>
      <section
        id="vision"
        className={styles.hero}
        aria-labelledby="daylight-title"
      >
        <div className={styles.heroPhotos}>
          <AnimatePresence initial={false}>
            <motion.div
              className={styles.photoPair}
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
              {heroPhotoIndices.map((photoIndex, index) => {
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
                      sizes={`(max-width: 760px) max(50vw, ${Math.ceil((photo.width / photo.height) * 100)}svh), max(30vw, ${Math.ceil((photo.width / photo.height) * 100)}svh)`}
                      preload
                      style={{ objectPosition: photo.position }}
                    />
                    <a
                      className={styles.panelLabel}
                      href={photo.source}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Photo by {photo.photographer}
                    </a>
                  </div>
                )
              })}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className={styles.heroCopy}>
          <h1 id="daylight-title">
            <span>ALWAYS</span>
            <span>YOUR</span>
            <span>
              VISION<span className={styles.orange}>.</span>
            </span>
          </h1>
        </div>
        <a href="#workflow" className={styles.scrollHint}>
          Scroll to explore <ArrowDown size={16} aria-hidden="true" />
        </a>
      </section>

      <section
        ref={workflowRef}
        id="workflow"
        className={styles.workflow}
        aria-labelledby="daylight-workflow-title"
      >
        <div className={styles.workflowHeading}>
          <h2 id="daylight-workflow-title">
            MAKE ROOM FOR
            <br />
            YOUR BEST WORK.
          </h2>
          <p>
            Every shoot holds something worth finding. Bring in your
            photographs, compare the possibilities, and carry your strongest
            selection forward.
          </p>
        </div>
        <div className={styles.workflowGrid}>
          <div
            className={styles.steps}
            aria-label="Explore the Photodepot workflow"
          >
            {workflow.map((item, index) => (
              <button
                type="button"
                key={item.name}
                aria-pressed={stage === index}
                onPointerEnter={() => warmDemoVideo(item.video)}
                onFocus={() => warmDemoVideo(item.video)}
                onPointerDown={() => warmDemoVideo(item.video)}
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
            <p className={styles.mobileStepDescription} aria-live="polite">
              {activeStage.text}
            </p>
          </div>
          <div className={styles.product}>
            <div className={styles.productImage}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeStage.name}
                  initial={{ opacity: reducedMotion ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: reducedMotion ? 1 : 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.18 }}
                >
                  <DemoMedia
                    demo={activeStage}
                    sizes="(max-width: 850px) 92vw, 54vw"
                  />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className={styles.reviewNote}>
              <UsersRound size={19} aria-hidden="true" />
              <p>
                <strong>Collaborate with your team.</strong> Cull and organize
                the same project from separate Macs on your local network.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="philosophy"
        className={styles.collection}
        aria-labelledby="daylight-philosophy-title"
      >
        <div className={styles.collectionIntro}>
          <h2 id="daylight-philosophy-title">
            POWERED <br />
            QUIETLY WITH <br />
            LOCAL AI.
          </h2>
          <p>
            Your photos are never sent to the cloud. Photodepot’s local AI
            supports your vision and saves you time, while keeping you in
            control of your craft.
          </p>
        </div>
        <div
          className={styles.aiNavigation}
          aria-label="Explore Photodepot’s local AI features"
        >
          {aiFeatures.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={selectedFeature === index}
              aria-controls="local-ai-feature"
              onPointerEnter={() => warmDemoVideo(item.video)}
              onFocus={() => warmDemoVideo(item.video)}
              onPointerDown={() => warmDemoVideo(item.video)}
              onClick={() => setSelectedFeature(index)}
            >
              <span className={styles.aiFeatureNumber}>0{index + 1}</span>
              <span className={styles.aiFeatureLabel}>{item.label}</span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div id="local-ai-feature" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={feature.id}
              className={styles.aiFeature}
              initial={{ opacity: reducedMotion ? 1 : 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: reducedMotion ? 1 : 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.15 }}
            >
              <div className={styles.aiScreenshot} data-feature={feature.id}>
                <DemoMedia
                  id="local-ai-animation"
                  demo={feature}
                  sizes="(max-width: 850px) 92vw, 58vw"
                />
              </div>
              <div className={styles.aiFeatureCopy}>
                <span className={styles.sectionLabel}>
                  0{selectedFeature + 1} / {feature.label}
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      <section
        id="collaboration"
        className={styles.collaboration}
        aria-labelledby="daylight-collaboration-title"
      >
        <div className={styles.collaborationFeature}>
          <div className={styles.collaborationHeading}>
            <h2 id="daylight-collaboration-title">
              Made with
              <br />
              teams in mind
            </h2>
            <p>
              Culling has traditionally been a solo task, even when the shoot
              takes a team. Photodepot brings everyone into the process, so you
              can review together, share decisions, and keep the work moving
              with less time spent passing photos around or coordinating access
              to a server.
            </p>
          </div>
          <figure className={styles.collaborationVisual}>
            <Image
              src={collaborationPhotograph.src}
              alt={collaborationPhotograph.alt}
              fill
              sizes="(max-width: 900px) 90vw, 40vw"
              style={{ objectPosition: collaborationPhotograph.position }}
            />
            <figcaption>
              <a
                className={styles.panelLabel}
                href={collaborationPhotograph.source}
                target="_blank"
                rel="noreferrer"
              >
                Photo by {collaborationPhotograph.photographer}
              </a>
            </figcaption>
          </figure>
        </div>
        <ol className={styles.collaborationSteps}>
          <li>
            <span className={styles.collaborationNumber}>01</span>
            <h3>Connect your team.</h3>
            <p>
              Bring your teammates into a shared project from their own Macs.
              Keep everyone connected to the same work, with less friction
              around sharing photos and coordinating access.
            </p>
          </li>
          <li>
            <span className={styles.collaborationNumber}>02</span>
            <h3>Cull together.</h3>
            <p>
              Review, rate, and flag photos alongside your teammates. Everyone
              can contribute without stepping on each other’s toes.
            </p>
          </li>
          <li>
            <span className={styles.collaborationNumber}>03</span>
            <h3>See every choice.</h3>
            <p>
              Use a shared knowledge base to keep the team’s picks, ratings, and
              flags in view. See what’s been decided and build on each other’s
              work.
            </p>
          </li>
        </ol>
      </section>

      <section
        id="waitlist"
        className={styles.closing}
        aria-labelledby="daylight-closing-title"
      >
        <div className={styles.closingBody}>
          <blockquote className={styles.closingQuote}>
            <h2 id="daylight-closing-title">
              Photography
              <br />
              is about
              <br />
              finding things
            </h2>
            <p className={styles.closingCredit}>
              — <cite>Saul Leiter</cite>
            </p>
          </blockquote>
          <div className={styles.closingCta}>
            <LandingWaitlistTrigger showArrow={false} />
            <p className={styles.closingTagline}>
              <em>built for creatives</em>
            </p>
          </div>
        </div>
      </section>
    </LandingSections>
  )
}
