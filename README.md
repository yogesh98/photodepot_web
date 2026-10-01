# photodepot download page

A light-only download page using PhotoDepot's app icon, locally bundled Inter
font, and the existing stone / Mira shadcn preset. The workflow line matches the
app's welcome screen.

## Run

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

## Configure downloads

Set one shared password in `.env.local`, or `.env` / your hosting provider's
runtime environment when deploying:

```dotenv
PHOTODEPOT_DOWNLOAD_PASSWORD="your-long-private-password"
```

Copy the installers into `public/downloads/` using these exact names:

- Apple Silicon: `photodepot-0.1.0-arm64.dmg`
- Intel Mac: `photodepot-0.1.0-x64.dmg`

Both current releases have been copied from the sibling PhotoDepot repository.
DMGs are ignored by Git; upload them manually on deployment. To use different
filenames, update `DOWNLOAD_FILES` in `lib/download-files.ts`.

The server checks the password and issues a signed, HttpOnly cookie granting
access to the selected build for five minutes. Files are streamed from disk
without buffering the whole installer. Direct `/downloads/` URLs are blocked by
`proxy.ts`, including encoded paths. Both API routes require authentication.
Missing passwords or files keep downloads closed. Changing the password
invalidates existing access cookies; restart after changing environment values.
Next.js expands `$` in `.env` values; escape it as `\$` if your password contains it.

Deploy with HTTPS and a Node.js runtime (`pnpm build`, then `pnpm start`), not a
static export. All requests to `public/downloads` must pass through Next.js and
its proxy; do not expose that folder separately through a static server or CDN.
Upload installers before starting the server. For standalone deployments, copy
`public/` alongside the standalone server. Choose hosting that supports streaming
these approximately 250 MB files within its response-size and timeout limits.
Password attempts are limited to eight per IP per ten minutes in each server
process. For multiple instances, configure a shared hosting-edge rate limit and
ensure the proxy overwrites untrusted `X-Forwarded-For` headers.

## Waitlist

The link below the downloads opens an interest form. First name, email, and
how the visitor heard about PhotoDepot are required; last name is optional.
`POST /api/waitlist` validates and saves submissions to a server-side SQLite
`waitlist` table, including a UTC creation timestamp. Emails are normalized to
lowercase and unique; repeat submissions succeed without replacing the original.

The database and its parent directory are created automatically on the first
submission at `data/waitlist.sqlite` and ignored by Git. To change the location:

```dotenv
PHOTODEPOT_WAITLIST_DB_PATH="/var/lib/photodepot/waitlist.sqlite"
```

Use Node.js 22.18+ for the built-in SQLite API and the test runner. Deploy on a
server with a writable persistent disk, and keep the database outside `public/`.
Mount that disk at the configured path so signups survive restarts and redeploys;
ephemeral serverless filesystems will not retain the waitlist. Back up the
database using SQLite's backup tools.

## Verify

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests use Node's built-in runner and TypeScript support (Node 22.18+).
Brand assets are copied from the sibling `photodepot` repository. The Inter font
license is in `app/fonts/OFL.txt`.
