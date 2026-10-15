import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../../../../lib/cloudflare.ts"
import { handleDesktopSession } from "../../../../lib/account-sessions.ts"
export const onRequest: PagesFunction<Env> = (context) =>
  handleDesktopSession(
    context.request as unknown as Request,
    context.env,
    "verify"
  ) as unknown as ReturnType<PagesFunction<Env>>
