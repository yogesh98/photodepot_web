import { BodyError, json, readJson, type Env } from "./cloudflare.ts"
import {
  CHALLENGE_PATTERN,
  LICENSE_KEY_PATTERN,
  hashLicenseKey,
  normalizeLicenseKey,
  parseDevicePublicKey,
  signedReceipt,
  signingKey,
  validDeviceProof,
} from "./license-crypto.ts"
import { allowLicenseAttempt } from "./license-rate-limit.ts"
import { activateDevice, findDevice } from "./license-store.ts"
import { getSubscriptionDevice } from "./subscription-devices.ts"
import { getWorkOSUser } from "./workos-users.ts"

export async function handleLicenseRequest(
  request: Request,
  env: Env,
  action: "activate" | "verify"
) {
  if (request.method !== "POST") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "POST")
    return response
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Submit JSON." }, 415)
  let supplied: unknown
  try {
    supplied = await readJson(request)
  } catch (error) {
    return json(
      { error: "Invalid request." },
      error instanceof BodyError ? error.status : 400
    )
  }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    return json({ error: "Invalid request." }, 400)
  const body = supplied as Record<string, unknown>
  if (
    typeof body.challenge !== "string" ||
    !CHALLENGE_PATTERN.test(body.challenge)
  )
    return json({ error: "Invalid challenge." }, 400)
  try {
    const signer = signingKey(env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY)
    const allowed = await allowLicenseAttempt(
      env.DB,
      action,
      request.headers.get("cf-connecting-ip") ?? "unknown",
      env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY!,
      action === "activate" ? 12 : 120,
      action === "activate" ? 600_000 : 60_000
    )
    if (!allowed) {
      const response = json(
        { error: "Too many requests. Please try again shortly." },
        429
      )
      response.headers.set("Retry-After", action === "activate" ? "600" : "60")
      return response
    }
    if (action === "activate") {
      const key =
        typeof body.key === "string" ? normalizeLicenseKey(body.key) : ""
      if (!LICENSE_KEY_PATTERN.test(key))
        return json({ error: "Enter a valid Photodepot license key." }, 400)
      let device
      try {
        device = parseDevicePublicKey(body.devicePublicKey)
      } catch {
        return json({ error: "Invalid device key." }, 400)
      }
      if (
        !validDeviceProof(device.key, body.signature, [
          "photodepot-license-v1",
          "activate",
          key,
          body.devicePublicKey as string,
          body.challenge,
        ])
      )
        return json({ error: "Device verification failed." }, 401)
      if (await getSubscriptionDevice(env.DB, device.deviceId))
        return json(
          {
            error:
              "This Mac uses an account subscription. Sign in with your Photodepot account to continue.",
          },
          409
        )
      const row = await activateDevice(
        env.DB,
        hashLicenseKey(key),
        device.deviceId,
        body.devicePublicKey as string
      )
      if (!row)
        return json(
          {
            error:
              "This license is invalid, revoked, or assigned to another Mac. Contact Photodepot for help.",
          },
          409
        )
      return json(
        signedReceipt(signer, {
          licenseId: row.id,
          deviceId: device.deviceId,
          type: row.type,
          status: "active",
          challenge: body.challenge,
          revision: row.revision,
        })
      )
    }
    if (
      typeof body.deviceId !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.deviceId)
    )
      return json({ error: "Invalid device." }, 400)
    const now = Date.now()
    const accountDevice = await getSubscriptionDevice(
      env.DB,
      body.deviceId,
      now
    )
    if (accountDevice) {
      const device = parseDevicePublicKey(accountDevice.publicKey)
      if (
        device.deviceId !== body.deviceId ||
        !validDeviceProof(device.key, body.signature, [
          "photodepot-license-v1",
          "verify",
          body.deviceId,
          body.challenge,
        ])
      )
        return json({ error: "Device verification failed." }, 401)
      const user = await getWorkOSUser(env, accountDevice.userId)
      const active =
        user?.id === accountDevice.userId &&
        user.emailVerified &&
        accountDevice.subscription.status === "active" &&
        accountDevice.subscription.startsAt <= now &&
        accountDevice.currentDeviceId === body.deviceId &&
        accountDevice.currentBindingRevision === accountDevice.bindingRevision
      return json(
        signedReceipt(
          signer,
          {
            licenseId: accountDevice.subscription.id,
            deviceId: body.deviceId,
            type: accountDevice.subscription.type,
            status: active ? "active" : "revoked",
            challenge: body.challenge,
            revision: accountDevice.subscription.revision,
          },
          now,
          accountDevice.subscription.endsAt
        )
      )
    }
    const row = await findDevice(env.DB, body.deviceId)
    if (!row)
      return json({ error: "Activate a license on this Mac to continue." }, 404)
    const device = parseDevicePublicKey(row.public_key)
    if (
      device.deviceId !== body.deviceId ||
      !validDeviceProof(device.key, body.signature, [
        "photodepot-license-v1",
        "verify",
        body.deviceId,
        body.challenge,
      ])
    )
      return json({ error: "Device verification failed." }, 401)
    const active =
      row.status === "active" &&
      row.current_device_id === body.deviceId &&
      row.binding_revision === row.device_binding_revision
    if (active)
      await env.DB.prepare(
        "UPDATE licenses SET last_verified_at = ? WHERE id = ?"
      )
        .bind(Date.now(), row.id)
        .run()
    return json(
      signedReceipt(signer, {
        licenseId: row.id,
        deviceId: body.deviceId,
        type: row.type,
        status: active ? "active" : "revoked",
        challenge: body.challenge,
        revision: row.revision,
      })
    )
  } catch {
    console.error("License verification service unavailable")
    return json(
      {
        error:
          "License verification is temporarily unavailable. Please try again shortly.",
      },
      503
    )
  }
}
