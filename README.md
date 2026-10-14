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
its Apple Silicon and Intel download buttons. Downloads are currently paused while
desktop licensing is checked locally; the buttons are disabled and both API routes
return the unavailable notice without reading R2. A license key is required in the
desktop app to open or create local projects.

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
Functions handle `/api/waitlist` and `/api/download/arm64` or `/api/download/x64`.
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
admin Access settings in the ignored `.dev.vars` file when testing licensing;
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

Downloads are temporarily paused with `DOWNLOADS_ENABLED = false` in
`lib/download-files.ts`. Website installer copies and hosted R2 installers have
been removed, and upload commands refuse to run while paused. Re-enable the flag
only when a licensed desktop release is ready.

For that release, keep DMGs in the ignored `downloads/` folder, **outside `public/`**:

- `photodepot-0.1.6-arm64.dmg`
- `photodepot-0.1.6-x64.dmg`

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
by Cloudflare Access. The old `download_attempts` table is retained by the
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

## Verify

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm functions:build
```

Tests use Node's built-in runner and Cloudflare's local D1/R2 runtime. API test
bindings are isolated and do not access production storage. Tests cover paused
GET/HEAD downloads without R2 access, byte-range parsing and invalid requests; D1 waitlist
persistence and duplicates; license administration and verification; and static
asset leakage prevention.
Brand assets are copied from the sibling `photodepot/build/brand` directory:
the canonical SVG lockup is used in both headers, the 1024-pixel app icon is used
on `/tester` and in social previews, and the ICO and simplified SVG supply browser
icons. The app icon also supplies the Apple touch icon. Regenerate the sibling
media kit with `pnpm brand:generate` before copying updated exports here.
Photography credits are in `public/photography/pexels/README.md`; the Inter font license is in
`app/fonts/OFL.txt`.

## Licenses

Manual license administration is available at `/admin/licenses` after Cloudflare Access, D1 and signing secrets are configured. See [licensing setup and protocol](deploy/LICENSES.md) before deploying a licensed desktop build. Production migration, Access configuration, secrets and deployment are separate release steps.

Revocation and Mac resets update the server immediately. The desktop saves the latest signed license state and applies local access restrictions after the app is closed and reopened. An admitted session keeps its ongoing work, hosting, and collaboration until quit. Closing a project or window does not end that session. Offline launches still use the 48-hour/10-startup allowance; joining a licensed host remains available without a local license.
