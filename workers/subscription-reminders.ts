// Retained so an existing Worker can be redeployed safely. Subscription billing
// notifications are managed by Stripe; legacy manual reminders never run.
const reminderWorker = {
  async scheduled() {},
  fetch() {
    return new Response("Not found", { status: 404 })
  },
}
export default reminderWorker
