import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../../../lib/cloudflare.ts"
import { handleAdminLogout } from "../../../lib/license-admin-auth.ts"
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminLogout(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
