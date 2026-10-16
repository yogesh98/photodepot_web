import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateLicenseAdmin,
  withAdminSession,
} from "../../../lib/license-admin-auth.ts"
import { json, type Env } from "../../../lib/cloudflare.ts"

export async function handleAdminSubscriptionRequests(
  request: Request,
  env: Env
) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  return withAdminSession(
    json(
      {
        error:
          "Access requests, manual grants, and their reminders have been retired. Manage subscriptions and discounts in Stripe.",
      },
      410
    ),
    auth
  )
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminSubscriptionRequests(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
