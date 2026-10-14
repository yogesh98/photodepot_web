import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../../../../lib/cloudflare.ts"
import { handleAccountLogin } from "../../../../lib/license-admin-auth.ts"
export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountLogin(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
