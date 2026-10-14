"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { ArrowDownToLine, Check, Cpu } from "lucide-react"
import { Button } from "@/components/ui/button"

const builds = [
  {
    architecture: "arm64",
    label: "Apple Silicon",
    hint: "M-series chips",
    variant: "default",
  },
  {
    architecture: "x64",
    label: "Intel Mac",
    hint: "Intel processors",
    variant: "outline",
  },
] as const

export function DownloadButtons() {
  const [started, setStarted] = useState(false)

  return (
    <>
      <div className="download-buttons">
        {builds.map((build) => (
          <div key={build.architecture} className="download-option">
            <Button
              variant={build.variant}
              className="download-button"
              nativeButton={false}
              render={<a href={`/api/download/${build.architecture}`} />}
              onClick={() => setStarted(true)}
            >
              <ArrowDownToLine size={17} aria-hidden="true" />
              Download for {build.label}
            </Button>
            <span className="chip-hint">
              <Cpu size={12} aria-hidden="true" />
              {build.hint}
            </span>
          </div>
        ))}
      </div>
      {!started && (
        <Suspense fallback={null}>
          <DownloadError />
        </Suspense>
      )}
      {started && (
        <p className="download-message" role="status">
          <Check size={14} aria-hidden="true" />
          Your download is starting.
        </p>
      )}
    </>
  )
}

// Only the redirect notice depends on the URL, so the page and download links
// can be pre-rendered as static HTML during the production build.
function DownloadError() {
  const downloadError = useSearchParams().get("download")
  if (!downloadError) return null
  return (
    <p className="download-message download-error" role="alert">
      This download isn&apos;t available right now. Please try again later.
    </p>
  )
}
