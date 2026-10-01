export const WAITLIST_LIMITS = {
  firstName: 100,
  lastName: 100,
  email: 254,
  heardAboutUs: 500,
} as const

export type WaitlistEntry = {
  firstName: string
  lastName: string
  email: string
  heardAboutUs: string
}

export function validateWaitlistEntry(
  value: unknown
): { ok: true; entry: WaitlistEntry } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Please fill out the interest form." }
  }

  const fields = value as Record<string, unknown>
  const entry: WaitlistEntry = {
    firstName: "",
    lastName: "",
    email: "",
    heardAboutUs: "",
  }
  for (const field of Object.keys(WAITLIST_LIMITS) as (keyof WaitlistEntry)[]) {
    const supplied = fields[field] ?? (field === "lastName" ? "" : undefined)
    if (typeof supplied !== "string") {
      return { ok: false, error: "Please fill out the interest form." }
    }
    entry[field] = supplied.trim()
    if (entry[field].length > WAITLIST_LIMITS[field]) {
      return { ok: false, error: "One of your answers is too long." }
    }
  }

  if (!entry.firstName) {
    return { ok: false, error: "Please enter your first name." }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) {
    return { ok: false, error: "Please enter a valid email address." }
  }
  if (!entry.heardAboutUs) {
    return { ok: false, error: "Please tell us how you heard about us." }
  }

  entry.email = entry.email.toLowerCase()
  return { ok: true, entry }
}
