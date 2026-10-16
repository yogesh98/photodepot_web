import { json, type Env } from "./cloudflare.ts"

/** Historical key endpoints cannot issue or refresh access after the account cutoff. */
export async function handleLicenseRequest(
  _request: Request,
  _env: Env,
  _action: "activate" | "verify"
) {
  void [_request, _env, _action]
  return updateRequired()
}

export function updateRequired() {
  return json(
    {
      code: "update_required",
      error:
        "Update Photodepot and sign in with your account. Ask the Photodepot Owner to approve access if you previously used a license key.",
    },
    410
  )
}
