# Photodepot installers

Version 0.2.3 separates development storage and uses the Photodepot name in
production Keychain entries. Keep both signed, notarized
installers here, outside the public website:

- `photodepot-0.2.3-arm64.dmg`
- `photodepot-0.2.3-x64.dmg`

DMGs are ignored by Git. `pnpm downloads:upload` uploads them to the private R2
bucket, and `pnpm downloads:upload:local` seeds local development storage.
Versioned object keys and `DOWNLOADS_ENABLED` are defined in `lib/download-files.ts`;
update the mapping and re-enable downloads when releasing new builds. Upload before
deploying an updated mapping. The uploader refuses releases while downloads are paused.
The public `/api/download/arm64` and `/api/download/x64` endpoints stream downloads
using the R2 binding without a password. Keep public bucket access disabled.
Website builds fail if an installer appears in `public/` or `out/`.

Updater releases use separate ZIP and blockmap artifacts; do not add them to the
DMG mapping. Run `pnpm updates:upload --source <desktop>/dist/release/updates`
after building both architectures. That source contains `arm64/` and `x64/`,
each with `latest-mac.yml`, `photodepot-<version>-<arch>.zip`, and the matching
`.zip.blockmap`. If staging a copy here, use the ignored `downloads/updates/`
directory. The root README documents verification, feed publication, and rollout.
