import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../../../../lib/cloudflare.ts"
import { handleAccountPairing } from "../../../../lib/account-pairing.ts"
export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountPairing(
    context.request as unknown as Request,
    context.env,
    "start"
  ) as unknown as ReturnType<PagesFunction<Env>>
