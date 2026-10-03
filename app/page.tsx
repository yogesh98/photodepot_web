import { randomInt } from "node:crypto"
import { connection } from "next/server"
import { DaylightLanding } from "@/components/landing/daylight"
import { LandingShell } from "@/components/landing/shell"

const photoSets = [
  [0, 3],
  [2, 5],
  [1, 4],
]

export default async function Page() {
  await connection()
  const heroPhotoIndices = photoSets[randomInt(photoSets.length)]
  return (
    <LandingShell>
      <DaylightLanding heroPhotoIndices={heroPhotoIndices} />
    </LandingShell>
  )
}
