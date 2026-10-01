import { saveWaitlistEntry } from "@/lib/waitlist"
import { validateWaitlistEntry } from "@/lib/waitlist-validation"

export const runtime = "nodejs"

function json(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const origin = `${url.protocol}//${request.headers.get("host") || url.host}`
  if (request.headers.get("origin") !== origin) {
    return json({ error: "Invalid request." }, 403)
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return json({ error: "Please submit the interest form as JSON." }, 415)
  }

  let supplied: unknown
  try {
    const reader = request.body?.getReader()
    if (!reader)
      return json({ error: "Please fill out the interest form." }, 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return json({ error: "Your submission is too large." }, 413)
      }
      chunks.push(value)
    }
    supplied = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return json({ error: "Please fill out the interest form." }, 400)
  }

  const result = validateWaitlistEntry(supplied)
  if (!result.ok) return json({ error: result.error }, 400)

  try {
    saveWaitlistEntry(result.entry)
    return json({ ok: true })
  } catch (error) {
    console.error("Failed to save waitlist entry:", error)
    return json(
      { error: "We couldn't save your details. Please try again in a moment." },
      503
    )
  }
}
