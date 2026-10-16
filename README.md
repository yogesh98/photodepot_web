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
its Apple Silicon and Intel download buttons for version 0.2.5. Updated desktop
builds require login for all use, and an active account subscription to open or
create local projects or host collaboration. Joining collaboration is available
without a subscription. Legacy license-key and subscription-bound sign-in clients
must update and sign in; existing keys are not automatically converted to accounts.

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

Version 0.2.5 improves recovery after signed Mac removal while preserving remote
playback. An online Mac saves and closes local work as soon as it receives the
signed removal, then requires fresh account sign-in and browser approval to
reconnect. Account sign-in, administrator-assigned subscriptions, and up to two
connected Macs remain available. Both signed, notarized installers are published
together. This is the first updater-enabled release; install it manually from
the DMG to receive future updates in the app.

For that release, keep DMGs in the ignored `downloads/` folder, **outside `public/`**:

- `photodepot-0.2.5-arm64.dmg`
- `photodepot-0.2.5-x64.dmg`

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

### macOS OTA updates

The desktop release build also produces signed ZIPs, ZIP blockmaps, and one
`latest-mac.yml` for each architecture in `dist/release/updates/arm64/` and
`dist/release/updates/x64/`. Keep these files outside `public/` and `out/`;
Pages asset validation rejects updater archives, blockmaps and feeds there.
DMG downloads continue through the installer upload command above.

Deploy the update API routes once before publishing an updater-enabled desktop
release. Then publish both architectures from the completed desktop build:

```bash
pnpm updates:upload --source ../photodepot/dist/release/updates
# Seed the same private R2 binding for local testing:
pnpm updates:upload:local --source ../photodepot/dist/release/updates
```

The publisher validates both stable versions, exact ZIP basenames, SHA-512
digests, byte sizes and nonempty blockmaps before making storage changes. It
refuses files over 300 MiB and mismatched versions. It uploads versioned binaries
to `updates/macos/{arm64|x64}/`, downloads them back to verify their bytes, then
publishes the two mutable feeds last. Existing identical versioned files are
reused; conflicting bytes for an existing version are rejected. Historical ZIPs
and blockmaps remain available for differential downloads. Run only one
publisher at a time because Wrangler's uploader does not offer conditional
creation. The feeds publish sequentially; if a feed upload fails, rerun the same
validated release to finish publication.

Desktop clients use the public generic provider feeds at
`https://photodepot.app/api/updates/macos/arm64/latest-mac.yml` and
`https://photodepot.app/api/updates/macos/x64/latest-mac.yml`. The sibling
versioned ZIP and `.zip.blockmap` URLs support GET, HEAD, ETag and single byte
ranges. Configure the desktop generic provider with
`useMultipleRangeRequest: false`. Feeds use `Cache-Control: no-store`; versioned
artifacts use immutable caching. Missing updates return JSON 404 responses, and
storage failures return JSON 503 responses without installer-page redirects.
No cookie, password or account is required, and the R2 bucket stays private.

Users must install the first updater-enabled release manually from a DMG.
Updates require signed, notarized builds with the same app and signing identity;
test N → N+1 upgrades on Apple Silicon, Intel and an Intel app under Rosetta
before release. The first update generally downloads the full ZIP; subsequent
updates can reuse a cached ZIP for differential downloads, with a full download
fallback. To repair a faulty release, publish a higher fixed version. Removing a
feed prevents future discovery but cannot repair installations already updated.

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
restoration, individual Mac resets, direct customer Mac removal, renewal requests, admin review, reminder
delivery settings, server filtering, waitlist export, cancel/resume renewal, linkable user profiles, pagination, stale edits, session errors, and mobile keyboard
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

## Accounts and manual access

The Accounts directory is available at `/admin`. The previous `/admin/users`, `/admin/subscriptions`, and `/admin/licenses` URLs remain aliases. Creating an account or signing in permits joining collaboration; it does not grant local project or hosting access. An Owner must manually assign Trial or Standard access to each approved account. Signups never receive administration membership. Only the `owner` role in `WORKOS_ADMIN_ORGANIZATION_ID` can manage access. See [account setup and protocol](deploy/LICENSES.md).

Set `WORKOS_CLIENT_ID`, `WORKOS_ADMIN_ORGANIZATION_ID`,
`WORKOS_REDIRECT_URI=https://photodepot.app/api/auth/callback`, and a random
`WORKOS_COOKIE_PASSWORD` of at least 32 characters in Pages settings/secrets.
The server uses PKCE and encrypted HttpOnly session cookies. Add the server-only
encrypted `WORKOS_API_KEY` secret for listing users and checking account status.
Never include the key in browser assets or desktop builds. Apply D1
migrations, including the account-access migration, before starting the updated backend. Existing grant dates, notes, and audit history are preserved. Old canceled-renewal preferences become disabled reminders; they are not billing cancellations. The existing
`https://photodepot.app/api/account/webhook` endpoint still acknowledges signed
WorkOS notifications when `WORKOS_WEBHOOK_SECRET` is configured, but it does not
read or change subscriptions. A webhook is not required for manual access grants.

The admin workspace has Overview, Accounts, Waitlist, and Operations
views. Dashboard counts cover the complete database, including active trials,
standard access, upcoming expirations, waitlist signups, open requests, and Mac
sessions. Search and access filters run on the server across the WorkOS directory. Filtered
requests scan at most ten provider pages; a continuation remains available when
more accounts need to be searched, even if the current result is empty.

Each user has a linkable management view at `/admin?view=users&user=USER_ID`,
with identity information, access dates, reminder preference, notes, named Macs,
requests, and activity history. Admins can grant Trial or Standard access by
duration or exact date, extend, revoke, restore, remove Macs independently of access,
and record reasons and internal notes. Waitlist search includes name,
email, and referral source, with signup dates, source counts, and a CSV export
of exactly the loaded results. CSV cells are escaped against formula execution.

Operations contains access requests and reminders. **Approve and extend** opens
the access editor and saves the chosen grant, resolves the request, and records
both audits in one transaction. Stale grant or request revisions leave both
unchanged. Declining records the review without changing access. Existing request
and audit history remains available. Visible directory pages refresh
every 30 seconds while no profile, dialog, or mutation is open. Revision checks
reject stale writes. Expired sessions show a sign-in link and refresh recovery.
No payment provider or charging flow is connected.

The UI reuses the desktop app's shadcn Base Mira / stone configuration and
component source, including the `sidebar-07` block on both dashboards. Owners
can switch between Individual and Admin in the sidebar header. The switcher is
hidden until `/api/account/dashboard-access` confirms access. Individual sessions
check the current user's active Owner membership in the configured administration
organization; missing configuration or provider outages keep it hidden. Admin
sessions use the same authorization as the protected dashboard. The separate
account and admin session cookies remain audience-bound. Its sidebar, summary metrics, and table organization were
informed by [Subscription Management & Tracking Dashboard](https://dribbble.com/shots/18902481-Subscription-Management-Tracking-Dashboard)
and [Invoice Dashboard](https://dribbble.com/shots/20606044-Invoice-Dashboard-Subscription-management).
No visual assets or sample customer records from those designs are shipped.

Desktop account sign-in opens WorkOS in the external browser, then asks the user
to confirm the named computer before using a free slot. If both slots are occupied,
it shows the named computers and their last use so the user can remove one and finish
signing in. Every app session requires a signed account session, including
joining collaboration. The account session is independent of the subscription:
a subscription enables local projects and hosting; joining collaboration is free
for signed-in users. The desktop receives signed receipts, never WorkOS tokens.
One account supports up to two signed-in Macs, including accounts without a plan.

Desktop Log out and the account console's Remove Mac revoke the same device
session. The app returns to login when it receives signed revocation. Reapproval
creates a new session ID; old proofs and approved pairing requests cannot restore
a revoked session. Removing one Mac leaves the other signed in. Updated clients
verify every 15 seconds and on app focus or sleep resume. Offline account receipts
last up to 48 hours; an offline Mac learns of removal when it reconnects or its
receipt expires. Subscription expiry removes local entitlement while preserving
login and joining collaboration. Device identity and receipts use encrypted local
storage, which can access macOS Keychain. The supported desktop uses one atomic
authorization record and one shared offline/clock ledger. Legacy clients receive
an update-required response; license-key users sign in and obtain Owner approval.

Every desktop approval requires an explicit Approve computer sign-in action naming
the computer, including browser launches from the app and returns from hosted authentication.
Browser navigation metadata does not establish which app initiated a request.
Approval uses a fresh, account/session/pairing-bound CSRF token and a same-origin
POST; GET does not admit a device. Replacing a computer and admitting the new one
share one guarded transaction. Cancellation also revokes a concurrently approved
session in one transaction. Success uses the Photodepot logo and wordmark.

### Customer account and requests

Users can sign in at `/account` to view their trial or standard access, expiry, and
connected Macs. Account cookies are separate from admin cookies. Customers see
only their own access, devices, and latest 50 requests; administrator notes, review
notes, access audits, and device keys are excluded. Grant revisions guard concurrent
preference changes. Connected Macs are independent of access, so both customers and
Owners can remove free-account sessions too.

Users remove a connected Mac directly with a same-origin `remove-device` action,
its device ID, session ID, and expected session revision. The server accepts only
the authenticated account's current session, revokes it, and frees its slot. The
other Mac and subscription remain unchanged. Stale edits require refreshing the
account. Device operations use session revisions; they do not update grant
revisions. Historical assignments remain stored but no longer authorize use.

**Request access/extension** requires administrator review. Retries return the existing
open request, with up to five new requests per rolling 24 hours. Acknowledged
requests stay open until completed or declined. Requests never extend access or
collect payment. Approval and the selected access grant are atomic; reviews use
revision checks and retain a separate audit.

Customers and Owners can enable or disable access reminders. This preference
does not revoke or extend access, reset Macs, or create/cancel a paid subscription.
It does not prevent requesting an extension. Existing canceled manual terms are
migrated to reminders disabled, preserving their original audit history.

### Future billing boundary

WorkOS owns identity, desktop sessions own device approval, and one server access
resolver owns local-project/hosting entitlement. The existing `subscriptions` table
stores manual grants rather than invoices or paid subscription state. The desktop
receives the effective signed permission and deadline, without billing-provider data.

Stripe checkout, billing management, invoices, paid cancellation, coupons, and
promotion codes belong to the later billing integration. Use Stripe's hosted flows
and native discounts rather than a second coupon engine. WorkOS's Stripe add-on
requires a private personal organization for each paying customer's Stripe customer;
keep those organizations separate from the administration organization, without
team UI or seat sync. Existing manual accounts must explicitly opt into paid checkout.
For a paying customer, **Extend** must postpone the next charge through Stripe and
derive access from its confirmed result. A local expiry edit is never a billing extension.

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
