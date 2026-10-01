"use client"

import { Dialog } from "@base-ui/react/dialog"
import { useState } from "react"
import { DownloadButtons } from "@/components/download-buttons"
import { WaitlistButton } from "@/components/waitlist-button"

export function DownloadActions() {
  const [waitlistHandle] = useState(() => Dialog.createHandle<void>())

  return (
    <>
      <DownloadButtons waitlistHandle={waitlistHandle} />
      <WaitlistButton handle={waitlistHandle} />
    </>
  )
}
