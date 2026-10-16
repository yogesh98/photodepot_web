# Photodepot accounts and manual access

The Accounts directory lives at `/admin`; `/admin/users`, `/admin/subscriptions`,
and `/admin/licenses` remain aliases. WorkOS owns identity, `desktop_sessions`
owns approved computers, and one server access resolver determines local-project
and hosting access. Signing in permits free joining of collaboration. Owners
assign Trial or Standard access; signups never grant access or Owner membership.
The existing `subscriptions` table stores manual grants, preserving dates, notes,
revisions, and audit history. It is not a billing ledger.

Owners can grant, extend, revoke/restore, save notes, and remove named Macs.
Extension adds days from the later of now and expiry and preserves revoked status.
Restore keeps expiry. Revision conflicts return 409. Device removal works for free
accounts and uses session revisions independently of grants.

Customer account responses separate `access`, `devices`, `requests`, and reminder
preferences. Customers never receive administrator notes, review notes, device
keys, or administrator audits. **Request access/extension** is deduplicated and
limited to five new requests in 24 hours. **Approve and extend** opens the grant
editor; a guarded transaction saves the chosen grant, resolves the request, and
records both audits. A stale request or grant leaves both unchanged. Declining
only reviews the request. Existing request and audit history stays readable.

Reminders are explicit preferences rather than billing cancellation. Trial mail
is eligible in the final 48 hours through the existing deduplicated outbox; see
[reminder delivery](../workers/README.md). No payment provider is connected.
The optional signed WorkOS webhook acknowledges notifications without granting
access or changing billing.

## Configure before deployment

These settings apply to account sign-in and signed access receipts.

1. Apply D1 migrations to the existing DB binding, first locally with `pnpm db:migrate:local` and then in production with `pnpm db:migrate`. Record the existing recovery bookmark with `pnpm exec wrangler d1 time-travel info DB --json` before migration, or keep an authorized private D1 backup. `0003_subscriptions.sql`, `0004_account_devices.sql`, and `0005_account_pairings.sql` add subscription/device/pairing records and preserve legacy license, waitlist, and download data. Apply all current migrations, including the account-access migration. Historical license/device records remain stored but no longer authorize use. Legacy bridging triggers are removed, and canceled manual renewal preferences become reminder opt-outs without changing grant dates or audit history.
2. Generate the Ed25519 signing pair outside either repository:

   ```sh
   node scripts/generate-license-keypair.mjs /absolute/private/location/photodepot-license-private-key.txt
   ```

   The file contains the **base64 DER PKCS8 private key** and is created with mode 0600 without overwriting existing files. The command prints only `PHOTODEPOT_LICENSE_PUBLIC_KEY`, the public key in base64url DER SPKI format. Save the private key in a secure backup. Set the printed public key as `PHOTODEPOT_LICENSE_PUBLIC_KEY` when building the desktop app, and use `PHOTODEPOT_LICENSE_API_URL=https://photodepot.app` (the default) for that build. The desktop API origin must match this deployment.

3. Set `PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY` as a Cloudflare Pages encrypted secret for `photodepot-web`. For example, run `pnpm exec wrangler pages secret put PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY --project-name photodepot-web` and provide the file contents privately. Do not put it in `wrangler.jsonc`, `NEXT_PUBLIC_*`, a git-tracked file, a shell command argument, or logs.
4. Configure WorkOS AuthKit in the intended environment with the standard hosted authentication domain. Set the application's **Initiate login URI** to `https://photodepot.app/api/account/auth/login`. AuthKit uses this URL when hosted sign-in needs to start again; pointing it at `/api/auth/login` incorrectly sends customers into the Owner organization flow. Register the exact redirect URI `https://photodepot.app/api/auth/callback` and the post-sign-out return URL `https://photodepot.app/`. Use standard email/password or Magic Auth; do not enable paid custom domains, Enterprise SSO, Directory Sync, Radar, or other add-ons. [AuthKit pricing](https://workos.com/pricing) currently includes RBAC and up to 1 million monthly active users free. This migration does not enable subscription charging.
5. Create or select a dedicated Photodepot administration organization. Create the environment-level **Owner** role with the exact slug **`owner`**, leave **Member** (`member`) as the default role, and manually assign Owner to the administrator's membership in that organization. Copy that organization's ID into the application configuration. An Owner in a different organization is not authorized. Do not automatically enroll new signups into the admin organization, enable email-domain auto-enrollment, or make Owner the default. [WorkOS roles documentation](https://workos.com/docs/authkit/roles-and-permissions) explains membership role assignment.
6. Set Pages environment variables `WORKOS_CLIENT_ID`, `WORKOS_ADMIN_ORGANIZATION_ID`, and `WORKOS_REDIRECT_URI=https://photodepot.app/api/auth/callback`. The administration organization setting is required only for Owner routes; customers do not need organization membership or that setting to sign in. Store `WORKOS_API_KEY` from the same WorkOS Production environment as an encrypted Pages secret. Generate a random `WORKOS_COOKIE_PASSWORD` of at least 32 characters and store it as another encrypted secret. Login uses public PKCE; the API key is used only by server user-management APIs. Keep secrets out of `wrangler.jsonc`, `NEXT_PUBLIC_*`, Git, command arguments, logs, and desktop builds. Missing or invalid settings fail closed.
7. Leave previews unavailable for sign-in/administration unless separate staging configuration is deliberate. Every admin API and page enforces Owner membership in the dedicated organization. Account login uses separate encrypted cookies and grants no administration access. All sign-in, subscription, pairing, approval, and verification responses are `private, no-store`; keep `/account/*` in Pages Function routing. A desktop built with a test public key cannot trust production receipts.
8. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:auth-browser`, `pnpm test:dashboard`, `pnpm build`, and `pnpm functions:build`, then deploy the backend. The authentication browser regression uses local fixtures and Chromium to verify that sign-out reaches the hosted session while the approval page still blocks external form submissions. Set `PHOTODEPOT_TEST_BROWSER_CHANNEL=chrome` to use installed Chrome instead of bundled Chromium. Production uses WorkOS as the administration login gate; the former Cloudflare Access application and settings were removed after verification. Check Owner access, Member/anonymous denial, alternate-host denial, subscription expiry/revocation, and account pairing. Desktop proof endpoints remain public and require cryptographic device signatures.
9. Test account sign-in and Trial/Standard subscriptions on a desktop build containing the matching vendor public key. Then release that desktop build through the established signing/notarization process.

For local testing, follow the website README's standard `pnpm preview` workflow and configure the license signing and WorkOS settings in `.dev.vars`. Register the matching local callback URI in WorkOS. The admin API requires an authenticated WorkOS session with the `owner` role in the configured admin organization. Automated integration tests use isolated authentication fixtures and never make real WorkOS calls. All builds use the same manual access policy.

## Administration sign-in

`GET /api/auth/login` starts Owner AuthKit sign-in. `GET /api/auth/callback` validates state, PKCE, token signature, client, user, verified email, and Owner organization before storing its encrypted cookie. `POST /api/auth/logout` signs out. Visiting `/admin` without a session starts sign-in; expired API sessions return401.

The application validates WorkOS access tokens on every protected request and refreshes expired tokens. Role changes and WorkOS session revocation are reflected when the current access token expires and refresh checks the session. Keep the access-token duration short in WorkOS application [session settings](https://workos.com/docs/authkit/sessions). Alternate hostnames are denied when their origin differs from the configured callback, even if they receive a copied session cookie.

The dashboard's **Sign in** link opens a new tab if its session expires; return and select **Refresh**. Visible user pages refresh every 30 seconds while dialogs and writes are closed. WorkOS outages preserve the existing list and show an error; an outage is never presented as an empty account list.

## Desktop account sign-in and access

WorkOS authentication stays in the external browser. The desktop keeps its protected
Ed25519 device identity and receives signed `{session, receipt?}` envelopes, never
WorkOS tokens. All supported clients use `Photodepot-Account-Version: 1` for pairing.
Pairing lasts ten minutes. Approval explicitly names the computer and requires a
fresh account/session/pairing-bound CSRF token and same-origin POST. GET and browser
navigation metadata never grant consent. Pending sign-in can be canceled.

One account has two Mac slots, regardless of access. With both occupied, the user
selects a named computer to remove and sign in. Replacement, capacity checks, and
new-session creation share one guarded transaction. Polling only delivers an
already-created session. Cancellation also revokes a concurrently approved session
atomically. Customer removal, Owner removal, and desktop logout use the same
session revocation transaction. Revoked sessions remain stored; reapproval creates
a new session ID, so stale logout/removal proofs cannot revoke its replacement.

`POST /api/account/pairing/start` accepts
`{deviceId,devicePublicKey,challenge,deviceSignature,deviceName?}`, signed over
`JSON.stringify(['photodepot-account-pairing-v1','start',deviceId,devicePublicKey,challenge])`.
Append the optional computer name to the array. Names are trimmed, bounded to 120
characters, and reject control characters. Poll/cancel proofs use
`['photodepot-account-pairing-v1','poll'|'cancel',pairingId,deviceId,challenge]`.
Approval and polling identifiers are independently hashed in storage.

Account claims remain
`{version:1,sessionId,deviceId,userId,email,status,revision,challenge,issuedAt,expiresAt}`.
`POST /api/account/session/verify` and `/logout` accept
`{sessionId,deviceId,challenge,deviceSignature,deviceName?}`. Proofs use
`['photodepot-account-session-v1','verify'|'logout',sessionId,deviceId,challenge]`,
with the optional name appended. Active verification updates name/last use without
changing the authentication revision, and rechecks removal across asynchronous
provider reads. Missing entitlement clears cached local access; deleted/unverified
accounts revoke login. Provider outages return 503 without extending offline time.

Account receipts last up to 48 hours. Entitlement receipts expire at the earlier
of 48 hours and grant expiry. Keep receipt v3 metadata and its separately signed
collaboration-compatible receipt unchanged. Both envelopes use vendor Ed25519
signatures and base64url encoding. Desktop validation binds signatures, device,
challenge, revision, and bounded timestamps; host proofs also bind a fresh challenge
and TLS/device identity. The server signing key must match the compiled public key.

The supported desktop stores one atomic encrypted authorization record containing
the session, optional entitlement, and shared launch/clock ledger. Migration accepts
validated matching old records, preserves stricter launch/clock limits and rollback
flags, and retains originals until durable save. Standalone legacy licenses never
admit an account. Ten offline launches, signed deadlines, rollback detection, and
a separate durable logout marker remain enforced. New grants require durable
storage; confirmed withdrawals close admission before storage writes. Routine
refresh failures cannot extend a previously saved lease.

Grant loss closes local work safely and stops hosting while preserving account
login and free joining. Device removal/logout also closes guest connections and
returns to login. Offline devices learn removal on reconnect or lease expiry.
Verification runs at startup, focus/resume, and every 15 seconds through one
coalesced pipeline. Cleanup retries do not depend on a UI state-change event.

Legacy license activation/verification and subscription-bound pairing return
update-required responses. Key users update, sign in, and receive Owner-assigned
account access; there is no automatic key conversion. Publish the supported desktop
before retiring old clients. Already-running historical binaries cannot be remotely
rewritten; retirement follows their existing verification and launch behavior.

Auth/access responses are `private, no-store`. Public proof routes retain atomic
HMAC-keyed rate limits without storing raw IPs or request bodies. Protect D1 and
device-key backups. Keep the signing key stable: rotation requires distributing a
desktop trusting the replacement public key first.

## Billing later

The access resolver is the integration boundary. Stripe will own paid terms,
invoices, cancellation, coupons, promotion codes, and charge dates through hosted
Checkout and billing management. WorkOS's Stripe add-on associates the customer
with a private personal organization, separate from the administration organization.
No team UI or seat sync is needed. Manual users enter billing only through explicit
checkout. Extending paid time must postpone the next charge in Stripe and use its
confirmed result for access; a local grant edit is not a billing extension. This
foundation adds no provider tables, checkout endpoints, or coupon engine.
