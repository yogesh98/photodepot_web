# photodepot website

The homepage at `/` uses the **Daylight** design: warm white backgrounds, dark
type, curated photograph pairs, and full-screen sections that snap vertically
as you scroll. The header stays visible while each section fills the remaining
viewport; shorter screens can scroll through content that needs extra room.
Desktop wheel and trackpad gestures advance one section at a time, pausing at
the edge of taller content until a fresh gesture. Small screens (760px wide or
less) and devices with a coarse pointer use normal scrolling without section
snapping or automatic section navigation.
It retains Photodepot’s original app icon, wordmark, and locally hosted Inter.
Seven curated Pexels photographs cover portraiture, bridal detail, architecture,
aerial and underwater photography, sculptural still life, and teams. Framer Motion and CSS
transitions respect reduced-motion preferences. Previous concept preview URLs
redirect to the homepage.

The landing page foregrounds collaboration with dedicated sections linked from
the header: one Mac hosts, approved reviewers cull and organize from their own
Macs on the same local network, and changes are shared across the project.
Ingest and export remain with the host. The complete Ingest, Cull, Organize, and
Export workflow is also explained. Joining the waitlist
is its only call to action. The original download page lives at `/tester`, with
its password-protected Apple Silicon and Intel downloads.

Screenshots show the actual Photodepot desktop app in light mode with demo
media. Capture and media provenance are documented in
`public/screenshots/README.md`.
All seven homepage product demos use GIF camera tours with smooth 50fps motion,
clean loops, and static posters for reduced-motion preferences. Only visible
demos play. Regenerate them with `scripts/generate-demo-gifs.py`; source images,
camera paths, and encoding reports are retained in `public/screenshots/demo-source/`.
GIF and poster URLs use content-hashed filenames through the generated
`components/landing/demo-assets.json`, so replacements receive new cache keys.

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

Both current releases have been copied from the sibling Photodepot repository.
DMGs are ignored by Git; upload them manually on deployment. To use different
filenames, update `DOWNLOAD_FILES` in `lib/download-files.ts`.

The server checks the password and issues a signed, HttpOnly cookie granting
access to the selected build for five minutes. Files are streamed from disk
without buffering the whole installer. Direct `/downloads/` URLs are blocked by
`proxy.ts`, including encoded paths. Both API routes require authentication.
Missing passwords or files keep downloads closed. Changing the password
invalidates existing access cookies; restart after changing environment values.
Next.js expands `$` in `.env` values; escape it as `\$` if your password contains it.

Deploy with a Node.js runtime (`pnpm build`, then `pnpm start`), not a
static export. HTTPS can terminate at your external reverse proxy while the VM
serves HTTP. Download cookies use the browser's protocol, passed through
`X-Forwarded-Proto`. All requests to `public/downloads` must pass through Next.js and
its proxy; do not expose that folder separately through a static server or CDN.
Upload installers before starting the server. For standalone deployments, copy
`public/` alongside the standalone server. Choose hosting that supports streaming
these approximately 250 MB files within its response-size and timeout limits.
Password attempts are limited to eight per IP per ten minutes in each server
process. For multiple instances, configure a shared hosting-edge rate limit and
ensure the proxy overwrites untrusted `X-Forwarded-For` headers.

## Waitlist

The landing page's Join waitlist buttons and the link on `/tester` open an
interest form. First name, email, and how the visitor heard about Photodepot
are required; last name is optional.
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

## Ubuntu VM deployment

To copy the codebase to the server, run this from a local Mac terminal outside
the SSH session:

```sh
rsync -av --exclude='node_modules' --exclude='.next' --exclude='.git' --exclude='data' /Users/yogeshpatel/Developer/photodepot_web/ photodepot@192.168.1.152:/home/photodepot/photodepot_web/
```

This copies into `/home/photodepot/photodepot_web` and overwrites matching files,
excluding local dependencies, build output, Git history, and waitlist data.
It includes `.env` and installers if present. Files that exist only on the
server are preserved.

Then reinstall dependencies on the server:

```sh
cd ~/photodepot_web
pnpm install
```

`deploy/install-vm.sh` installs Node 22 LTS and pnpm, installs Linux dependencies,
and runs `pnpm build` **on the VM**. It then runs
`next start` under `photodepot.service`, enabled at boot and restarted on failure.
The homepage is pre-rendered as static HTML; downloads and waitlist remain live
Node.js APIs. This deployment does not use the development server.

Upload this repository, `.env`, and both installers to the VM (exclude local
`node_modules`, `.next`, `.git`, and `data`). On the VM, run:

```sh
sudo bash ~/photodepot_web/deploy/install-vm.sh
```

The installer targets the `photodepot` Linux user and LAN IP `192.168.1.152`:

- App: `/srv/photodepot/app`
- Private environment: `/srv/photodepot/.env` (mode `0600`, preserved on reinstall)
- Persistent waitlist: `/var/lib/photodepot/waitlist.sqlite`
- URL / reverse proxy upstream: `http://192.168.1.152:80`
- Logs: `sudo journalctl -u photodepot -f`
- Restart after changing the password: `sudo systemctl restart photodepot`

Run `~/waitlist.sh` on the VM to print every waitlist signup, including the
name, email, referral answer, and UTC signup time. The script reads the database
path from the production `.env` and opens SQLite read-only.

Nginx serves HTTP on port 80 and forwards every request to Next.js, whose port
3000 only listens on loopback. It accepts the public domain in the `Host` header
and preserves `X-Forwarded-Proto` from your external reverse proxy. Configure
that proxy to preserve the original `Host` (including a nonstandard port) and
set `X-Forwarded-Proto` to the browser's scheme; this keeps same-origin forms,
redirects, and secure cookies working. There is no VM TLS certificate or HTTPS
redirect. Do not configure a separate static alias for installers.

Nginx overwrites forwarded client IP headers. To apply per-client rate limits
behind the external proxy, configure nginx's real-IP module with that proxy's
exact trusted IP so `$remote_addr` reflects the browser's IP.

## Verify

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests use Node's built-in runner and TypeScript support (Node 22.18+).
Brand assets are copied from the sibling `photodepot` repository. Photography
provenance and photographer credits are in `public/photography/pexels/README.md`. The Inter font
license is in `app/fonts/OFL.txt`.
