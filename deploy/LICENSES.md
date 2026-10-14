# Photodepot licensing

The dashboard lives at `https://photodepot.app/admin/licenses`. It grants a trial or regular license, shows masked keys, customer/email/notes, Mac assignment, last verification, and a recent audit history. Full license keys appear only in the grant response and the one-time key panel. Store/send them securely; there is no recovery endpoint. A lost key requires a replacement license and revocation of the old license.

Both license types remain active until manual revocation. One license binds to one Mac. Every Mac needs its own license to open or create local projects or host. Joining another licensed host does not require a license. A Mac currently assigned to an active license cannot consume another until its old assignment is reset. A revoked key can be replaced directly by activating a new key; that transaction releases the old revoked assignment so restoring it cannot take the Mac away from its replacement license. Resetting the assignment invalidates the previous device receipt at the next online check and lets the key activate a replacement Mac. Restoring a revoked license keeps the current Mac assignment. Reset and restore are separate actions.

## Configure before deployment

These are setup instructions; implementing this feature does not migrate or deploy production.

1. Apply the new D1 migration to the existing DB binding, first locally with `pnpm db:migrate:local` and later in production with `pnpm db:migrate`. Keep a D1 backup before production migration. Migration `0002_licenses.sql` adds license tables without changing the waitlist/download tables.
2. Generate the Ed25519 signing pair outside either repository:

   ```sh
   node scripts/generate-license-keypair.mjs /absolute/private/location/photodepot-license-private-key.txt
   ```

   The file contains the **base64 DER PKCS8 private key** and is created with mode 0600 without overwriting existing files. The command prints only `PHOTODEPOT_LICENSE_PUBLIC_KEY`, the public key in base64url DER SPKI format. Save the private key in a secure backup. Set the printed public key as `PHOTODEPOT_LICENSE_PUBLIC_KEY` when building the desktop app, and use `PHOTODEPOT_LICENSE_API_URL=https://photodepot.app` (the default) for that build. The desktop API origin must match this deployment.
3. Set `PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY` as a Cloudflare Pages encrypted secret for `photodepot-web`. For example, run `pnpm exec wrangler pages secret put PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY --project-name photodepot-web` and provide the file contents privately. Do not put it in `wrangler.jsonc`, `NEXT_PUBLIC_*`, a git-tracked file, a shell command argument, or logs.
4. In Cloudflare Zero Trust, create **one self-hosted Access application** with these application paths: `photodepot.app/admin/*`, `photodepot.app/api/admin/*` (add the bare `/admin` path if it is not covered). Add an Allow policy with only email `yogesh.patel0221@gmail.com`. Enable email one-time PIN or the intended identity provider. Do not use a Bypass/Everyone policy. Do **not** protect `/api/licenses/*`; the desktop calls those endpoints without Access cookies.
5. Set Pages environment variables `PHOTODEPOT_ACCESS_ISSUER=https://YOUR-TEAM.cloudflareaccess.com` and `PHOTODEPOT_ACCESS_AUDIENCE=YOUR-APPLICATION-AUD` from the application details. Both paths must share this audience. The code also restricts the signed email to `yogesh.patel0221@gmail.com`; allowing a second user at the edge does not grant application authorization. JWTs are verified against the issuer's Access RSA keys with RS256, issuer, audience, expiry and email validation. The email header alone never authorizes a request.
6. Disable public preview deployment access in Pages or add an equivalent Access policy for preview hostnames. Regardless of edge policy, application middleware protects `/admin/*` and the admin API independently verifies JWTs on **all** hostnames, including `pages.dev`; missing config/tokens never falls back to public access. Static JS/CSS contains only the dashboard shell, never license/customer data. Do not enable cache rules that override `private, no-store` on `/admin/*`, `/api/admin/*`, or `/api/licenses/*`.
7. Configure the same secrets/vars separately for preview only if needed. Prefer a separate D1 database and signing key for preview/testing; otherwise leave administration unavailable there. A desktop built with a test public key cannot trust production receipts.
8. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm functions:build`, then deploy the web backend using the existing deployment process. Test a trial key on a test desktop build, revoke/restore/reset it, then release a desktop build containing the matching public key. No existing installed desktop build gains enforcement until updated.

For local Pages development, copy `.dev.vars.example` into untracked `.dev.vars` and use a test key pair. The admin API has no development password/bypass: an actual signed Access JWT from a matching test Access application is required. Automated integration tests use ephemeral RSA issuer fixtures and never make real Access calls.

## Protocol and enforcement

`POST /api/licenses/activate` accepts JSON `{key, devicePublicKey, challenge, signature}`. Keys normalize with trim/uppercase. The device public key is base64url DER SPKI Ed25519. The challenge is 32 random bytes in base64url. The device signs the UTF-8 bytes of `JSON.stringify(['photodepot-license-v1','activate',normalizedKey,devicePublicKey,challenge])`.

`POST /api/licenses/verify` accepts `{deviceId, challenge, signature}`. The device ID is lowercase hex SHA-256 of the DER SPKI bytes. The device signs `JSON.stringify(['photodepot-license-v1','verify',deviceId,challenge])`. A client-provided device ID never suffices without a valid proof using the stored public key.

Successful responses are `{payload, signature}`, with both fields base64url. The vendor signature covers the **decoded payload bytes**, not the encoded text. Payload: `{version:1,licenseId,deviceId,type:'trial'|'regular',status:'active'|'revoked',issuedAt,expiresAt,challenge,revision}`. Times are UTC epoch milliseconds. `expiresAt=issuedAt+172800000` (48 hours). No customer email, name, notes or raw license key appears in a receipt. Revocations and invalidated old bindings return signed `status:'revoked'` receipts after valid device proof. The current server revision increases on changes. Database batches atomically enforce activation capacity and record administrative actions.

The desktop accepts only matching vendor signature, device, fresh request challenge, version, revision and bounded timestamps. Successful active verification resets its 48-hour/10-offline-startup allowance. Ten offline launches are allowed; the eleventh needs internet. Network outages and **all unsigned HTTP errors** never refresh a receipt or count as confirmed revocation. Confirmed revocation persists until a signed restoration. Revocation reaches offline Macs only when they reconnect or their grace allowance ends. Offline tampering resistance cannot make a user-controlled Mac fully tamper-proof.

Public API rate limits use atomic D1 counters keyed by an HMAC of the route and IP (12 activation attempts / 10 min, 120 verification attempts / min). Raw IPs and request bodies are not persisted or logged. Error responses use generic messages and `private, no-store`; there is no public license enumeration endpoint. The first activation requires internet. Server signing/DB outages return 503; existing valid desktop receipts retain only their remaining grace.

The signing key has a deliberately explicit release lifecycle: changing it requires distributing a desktop build trusting the replacement public key first. Existing builds cannot verify a new key automatically. Avoid rotating it without planning that transition. D1 rows and device keys are security-sensitive; protect backups and Cloudflare account access.
