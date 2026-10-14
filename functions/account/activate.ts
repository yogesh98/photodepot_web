import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../../lib/cloudflare.ts"
import { handleAccountApproval } from "../../lib/account-pairing.ts"
export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountApproval(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
