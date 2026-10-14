import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateLicenseAdmin,
  withAdminSession,
} from "../../../lib/license-admin-auth.ts"
import {
  BodyError,
  json,
  readJson,
  sameOrigin,
  type Env,
} from "../../../lib/cloudflare.ts"
import { listSubscriptions } from "../../../lib/subscription-store.ts"
import { subscriptionEnvironment } from "../../../lib/subscription-environment.ts"
import {
  AccountRequestConflictError,
  getAccountRequest,
  listAdminRequests,
  listRequestAudit,
  reviewAccountRequest,
} from "../../../lib/account-requests.ts"

export async function handleAdminSubscriptionRequests(
  request: Request,
  env: Env
) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  try {
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams
      if (query.has("requestId")) {
        const id = query.get("requestId") ?? ""
        const item = await getAccountRequest(env.DB, id)
        return withAdminSession(
          item
            ? json({ request: item, audit: await listRequestAudit(env.DB, id) })
            : json({ error: "Request not found." }, 404),
          auth
        )
      }
      const queue = await listAdminRequests(
        env.DB,
        query.get("includeClosed") === "1"
      )
      const subscriptions = await listSubscriptions(
        env.DB,
        queue.requests.map((item) => item.userId)
      )
      return withAdminSession(
        json({
          ...queue,
          environment: subscriptionEnvironment(env),
          requests: queue.requests.map((item) => ({
            ...item,
            subscription: subscriptions.get(item.userId) ?? null,
          })),
        }),
        auth
      )
    }
    if (request.method !== "POST") {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return withAdminSession(response, auth)
    }
    if (!sameOrigin(request))
      return withAdminSession(
        json({ error: "Invalid request origin." }, 403),
        auth
      )
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      return withAdminSession(json({ error: "Submit JSON." }, 415), auth)
    const body = await readJson(request)
    if (!body || typeof body !== "object" || Array.isArray(body))
      return withAdminSession(json({ error: "Invalid review." }, 400), auth)
    const supplied = body as Record<string, unknown>
    const result = await reviewAccountRequest(
      env.DB,
      {
        id: supplied.requestId as string,
        action: supplied.action as "acknowledge" | "resolve" | "reject",
        expectedRevision: supplied.expectedRevision as number,
        note: supplied.note as string | undefined,
      },
      auth.email
    )
    return withAdminSession(json({ request: result }), auth)
  } catch (error) {
    const status =
      error instanceof BodyError
        ? error.status
        : error instanceof AccountRequestConflictError
          ? 409
          : error instanceof TypeError
            ? 400
            : 503
    return withAdminSession(
      json(
        {
          error:
            status === 503
              ? "The request queue is temporarily unavailable. Please try again."
              : error instanceof Error
                ? error.message
                : "Invalid review.",
        },
        status
      ),
      auth
    )
  }
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminSubscriptionRequests(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
