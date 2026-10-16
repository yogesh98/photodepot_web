import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../../../../lib/cloudflare.ts"
import { handleWorkOSBillingAuthorize } from "../../../../lib/workos-billing-auth.ts"

export const onRequest: PagesFunction<Env> = (context) =>
  handleWorkOSBillingAuthorize(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
