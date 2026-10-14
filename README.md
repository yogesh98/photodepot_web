# photodepot website

The homepage at `/` uses the **Daylight** design: warm white backgrounds, dark
type, curated photograph pairs, and sections that fill at least the space below
the header. A full-height flex layout contains a native scrolling viewport
managed by Base UI Scroll Area. Its transparent overlay scrollbar floats over
the section backgrounds and fades when idle. Wheel, trackpad, touch, and keyboard
scrolling work normally at every screen size, including through taller sections.
The sticky header follows the active section's background color.
It uses Photodepot’s gallery mark and outlined wordmark, orange (`#ff5a22`),
ink (`#151613`), warm paper (`#f7f6f2`), and locally hosted Inter.
Seven curated Pexels photographs cover portraiture, bridal detail, architecture,
aerial and underwater photography, sculptural still life, and teams. Framer Motion,
CSS transitions, smooth anchor scrolling, scrollbar fading, and demo playback
respect reduced-motion preferences. Previous concept preview URLs redirect to
the homepage.

The landing page foregrounds collaboration with dedicated sections: one Mac
hosts, approved reviewers cull and organize from their own Macs on the same
local network, and changes are shared across the project.
Ingest and export remain with the host. The complete Ingest, Cull, Organize, and
Export workflow is also explained. Joining the waitlist
is its only call to action. The original download page lives at `/tester`, with
its Apple Silicon and Intel download buttons for version 0.2.1. An active account
subscription or compatible license is required in the desktop app to open or
create local projects.

Screenshots show the actual Photodepot desktop app in light mode with demo
media. Capture and media provenance are documented in
`public/screenshots/README.md`.
All seven homepage product demos use compressed, silent MP4 camera tours with
smooth 50fps motion and lossless WebP posters for reduced-motion preferences.
Only visible demos play. Regenerate them with `scripts/compress-demo-assets.py`;
source images, camera paths, GIF masters, and encoding reports are retained.
Video and poster URLs use content-hashed filenames through the generated
`components/landing/demo-assets.json`, so replacements receive new cache keys.

## Cloudflare hosting

The frontend is a Next.js static export hosted on Cloudflare Pages. Pages
Functions handle the waitlist, downloads, license API, and WorkOS authentication.
Installers live in a **private R2 Standard bucket**; the waitlist lives in D1.
Only `/api/*` and the protected `/admin` routes invoke Functions, so other website
assets use free static hosting.
The canonical production domain is **photodepot.app**.

The homepage uses a deterministic photo pair in the static HTML, then selects a
pair in the browser after hydration. Images are served from their existing local
assets without a runtime image optimizer. Content-hashed demo assets have
one-year immutable cache headers. Legacy concept URLs redirect to `/`.

The production build uses Webpack because Turbopack's CSS subprocess cannot bind
its internal port in this managed workspace. Both build paths support the static
export; this choice does not change the hosting architecture.

### Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm preview
```

Downloads do not require a password or cookie. Configure license signing and
admin WorkOS settings in the ignored `.dev.vars` file when testing licensing;
see `deploy/LICENSES.md`. Local secrets are server-only; never prefix them with
`NEXT_PUBLIC_`. Wrangler keeps local D1
and R2 data in ignored `.wrangler/state/`. Local preview normally runs at
`http://localhost:8788`. Rebuild and restart it after source changes.

`pnpm dev` retains Next.js's fast frontend development server. The live APIs run
in Wrangler's full-stack preview, rather than inside Next.js.

### Account setup

Sign in to the Cloudflare account managing photodepot.app, with Pages, Workers/R2,
D1, and DNS permissions. If R2 is not enabled, complete its subscription checkout
in the dashboard first. Authorize the official Cloudflare CLI:

```sh
pnpm cf:login
pnpm cf:setup
pnpm downloads:upload
pnpm run deploy
```

`cf:setup` creates or reuses `photodepot-downloads`, `photodepot-waitlist`, and the
Direct Upload project `photodepot-web`, saves the real D1 ID in `wrangler.jsonc`,
and applies migrations. The setup/upload/deploy script defaults to this project's
Cloudflare account; set `CLOUDFLARE_ACCOUNT_ID` to override it for another account.
License secret values stay in local files or Cloudflare Pages Secrets, outside
Git and the static build. Downloads require no secret. In `.dev.vars`, dollar
signs are literal; there is no Next.js-style variable expansion.

### Downloads and releases

Version 0.2.1 provides account sign-in, administrator-assigned subscriptions, and
up to two connected Macs. Both signed, notarized installers are published together.

For that release, keep DMGs in the ignored `downloads/` folder, **outside `public/`**:

- `photodepot-0.2.1-arm64.dmg`
- `photodepot-0.2.1-x64.dmg`

Update the versioned keys in `lib/download-files.ts` for a new release, upload
both installers, then deploy. Upload commands validate both files before writing
and print their SHA-256 checksums. Wrangler handles the current installers;
future files over 300 MiB require an S3 multipart upload tool.

Keep the R2 development URL and custom-domain access **disabled**. R2 is accessed
through the `DOWNLOADS` binding, so no S3 credentials are needed in the website.
The public download buttons link directly to `GET /api/download/arm64` and
`GET /api/download/x64`. Functions stream the private R2 objects without buffering
the installer and support HEAD and single-byte ranges. Download requests require
no password, cookie, license key or D1 access; project access is controlled by the
desktop license feature. Missing or unavailable installer storage returns users
to `/tester` with a download error. Admin license management remains protected
by WorkOS AuthKit with an Owner role in the configured admin organization. The old `download_attempts` table is retained by the
historical migration and is no longer used.

Builds and deploys reject installers, SQLite databases, environment
files, and assets over Pages' 25 MiB file limit.

### Waitlist

The existing form and validation remain: first name, email, and referral answer
are required; last name is optional. D1 normalizes email addresses, keeps each
email unique, and retains the original answer on repeat submissions.
The database starts fresh; existing VM signups are not imported.

```sh
pnpm --silent waitlist:export > waitlist-export.json
```

Exports contain personal information; keep them private and out of the
repository. `pnpm db:migrate` applies future remote migrations. No database
schema changes happen during signup requests.

### Deployment and domain

Future website updates use `pnpm run deploy`. Installer uploads and schema migrations
run separately when needed. This is a Direct Upload Pages project; Git integration
would require creating a new Pages project.

The migration was deployed and verified on October 8, 2026. The production site
is `https://photodepot.app`, backed by `photodepot-web.pages.dev`. Its apex DNS
record points to the Pages project. Both R2 installers passed complete SHA-256
checks, and live signup persistence and duplicate handling were verified. The
disposable signup was removed after verification; VM signups were not imported.

The previous apex record is saved in ignored `cloudflare-dns-backup.json`:
an A record for `photodepot.app` pointing to `69.121.238.220`, DNS only, TTL Auto.
To roll back, restore that record in Cloudflare DNS and verify the VM site.
Leave the existing VM running until rollback is no longer needed.
The legacy files under `deploy/` describe the old Node/SQLite server and must not
be used to install this static-export version on the VM.

### Free allowances

Use Pages/Workers Free and D1 Free, and R2 **Standard** storage. The current
installers total about 493 MiB. Pages static requests are free and unlimited;
Functions share the Workers Free allowance of 100,000 requests/day. R2 includes
10 GB-month of storage, 1 million Class A and 10 million Class B operations per
month, with free egress. R2 charges usage beyond its free allowances; this setup
does not guarantee a permanent zero bill. Review account-wide usage in the
Cloudflare dashboard and avoid retaining unused release binaries indefinitely.

- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Administration uses standard WorkOS hosted AuthKit login and role checks. AuthKit
and RBAC are free up to 1 million monthly active users under the current
[WorkOS pricing](https://workos.com/pricing). This integration does not require a
custom authentication domain, Enterprise SSO, Directory Sync, Radar, or other
paid add-ons. Subscription billing is not enabled by this change.

## Verify

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm functions:build
```

Tests use Node's built-in runner and Cloudflare's local D1/R2 runtime. API test
bindings are isolated and do not access production storage. Tests cover public
GET/HEAD downloads, byte ranges, unavailable storage and invalid requests;
D1 waitlist persistence and duplicates; license administration and verification;
and static asset leakage prevention.

The dashboard and customer account browser tests run against the built site and
isolated mock APIs. They cover manual grants, extensions, notes, revocation,
restoration, individual Mac resets, customer requests, admin review, reminder
delivery settings, filtering, pagination, stale edits, session errors, and mobile keyboard
access. Run them separately with an LTS Node.js release:

```sh
pnpm exec playwright install chromium
pnpm build
pnpm test:dashboard
# Alternatively, use an installed Chrome instead of downloading Chromium:
PHOTODEPOT_TEST_BROWSER_CHANNEL=chrome pnpm test:dashboard
```

Screenshots are saved in the ignored `.wrangler/dashboard-browser` directory.
These UI tests complement the D1/API tests; they do not contact WorkOS or change
production data.

Brand assets are copied from the sibling `photodepot/build/brand` directory:
the canonical SVG lockup is used in both headers, the 1024-pixel app icon is used
on `/tester` and in social previews, and the ICO and simplified SVG supply browser
icons. The app icon also supplies the Apple touch icon. Regenerate the sibling
media kit with `pnpm brand:generate` before copying updated exports here.
Photography credits are in `public/photography/pexels/README.md`; the Inter font license is in
`app/fonts/OFL.txt`.

## Account subscriptions

Subscription administration is available at `/admin/subscriptions`. Creating an account or signing in does not grant access. An Owner must manually assign Trial or Standard access to each approved account. Signups never receive administration membership. Only the `owner` role in `WORKOS_ADMIN_ORGANIZATION_ID` can manage access. See [subscription setup and protocol](deploy/LICENSES.md).

Set `WORKOS_CLIENT_ID`, `WORKOS_ADMIN_ORGANIZATION_ID`,
`WORKOS_REDIRECT_URI=https://photodepot.app/api/auth/callback`, and a random
`WORKOS_COOKIE_PASSWORD` of at least 32 characters in Pages settings/secrets.
The server uses PKCE and encrypted HttpOnly session cookies. Add the server-only
encrypted `WORKOS_API_KEY` secret for listing users and checking account status.
Never include the key in browser assets or desktop builds. Apply D1
migrations through `0009` before starting the updated backend. The existing
`https://photodepot.app/api/account/webhook` endpoint still acknowledges signed
WorkOS notifications when `WORKOS_WEBHOOK_SECRET` is configured, but it does not
read or change subscriptions. A webhook is not required for manual access grants.

The dashboard shows whole-database subscription totals, trials,
expirations in the next seven days, and Mac assignments. Search and status/type
filters apply to loaded WorkOS users, with explicit pagination. Admins can grant
Trial or Standard access by duration or exact end date, extend, revoke, restore,
reset an individual Mac or both Macs, record a reason, keep internal notes, and
inspect audit history. The customer request queue shows renewals and requests to
remove a specific Mac. Admins can acknowledge, complete, or decline a request with
internal review notes. Review status changes never grant access or reset a device;
apply those changes from account details, then complete the request.
Visible pages refresh every 30 seconds while no dialog or mutation is open.
Revision checks reject stale writes. If a session expires, Sign in opens a new
tab; return and select Refresh. No payment provider or charging flow is connected.

Desktop account sign-in opens WorkOS in the external browser and asks the user
to approve the Mac. The desktop receives a signed finite receipt, with no WorkOS
tokens or API key. One account supports up to two Macs. An individual reset
releases only the selected Mac and leaves the other Mac’s access intact. Resetting
all Macs invalidates both assignments and earlier approved pairing requests.
Receipt expiry is capped at the subscription end
and 48 hours. An admitted session keeps its work and collaboration until quit;
expiry, revocation, and offline limits are enforced on the next app launch.
Device identity and receipts use encrypted local storage, which can access macOS
Keychain. The app exposes account sign-in and subscription access.

### Customer account and requests

Users can sign in at `/account` to view their trial or standard plan, expiry, and
connected Macs. Account cookies are separate from admin cookies. Customers see
only their own subscription and latest 50 requests; administrator notes, review
notes, subscription audits, device keys, and internal revisions are excluded.

Renewal and Mac removal requests require the signed-in account and same-origin
JSON submission. A Mac removal must select one of that account’s current Macs.
At most one open request is allowed per account, request type, and Mac; retries
return the existing request instead of duplicating it. Acknowledged requests stay
open until completed or declined. New requests are limited to five per rolling
24 hours. Requests never immediately change access and never collect payment.
Admin reviews use revision checks and retain a separate administrator audit.

### Daily renewal queue and trial reminders

The admin dashboard lists active trials and standard subscriptions ending within
seven days. Trial reminder messages are prepared once per trial term during the
final 48 hours. The queue also shows delivery status, message history, and
failed or uncertain attempts. Select **Check reminders now** to process due
trials; this uses the same routine as the scheduled worker.

Email delivery is disabled until a provider and sender are configured.
The optional Resend adapter, worker setup, and hourly due-reminder
checks are documented in
[the reminder worker guide](workers/README.md). Standard plans appear in the
renewal queue but do not receive the trial email.
