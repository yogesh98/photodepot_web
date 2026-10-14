interface ReminderSchedulerEnv {
  PHOTODEPOT_APP_URL: string
  PHOTODEPOT_REMINDER_TOKEN: string
}
export async function triggerReminders(
  env: ReminderSchedulerEnv,
  transport: typeof fetch = fetch
) {
  const url = new URL(env.PHOTODEPOT_APP_URL)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("Invalid reminder server URL")
  if (
    !env.PHOTODEPOT_REMINDER_TOKEN ||
    env.PHOTODEPOT_REMINDER_TOKEN.length < 32
  )
    throw new Error("Reminder scheduler is not configured")
  for (let batch = 0; batch < 10; batch++) {
    const response = await transport(
      new URL("/api/internal/subscription-reminders", url),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(180_000),
        headers: { Authorization: `Bearer ${env.PHOTODEPOT_REMINDER_TOKEN}` },
      }
    )
    if (!response.ok)
      throw new Error(`Reminder batch failed (${response.status})`)
    const result = (await response.json()) as { remaining?: boolean }
    if (result.remaining !== true) return
  }
}
const reminderWorker = {
  async scheduled(_event: unknown, env: ReminderSchedulerEnv) {
    await triggerReminders(env)
  },
  fetch() {
    return new Response("Not found", { status: 404 })
  },
}
export default reminderWorker
