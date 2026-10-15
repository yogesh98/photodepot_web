# Photodepot installers

Version 0.2.4 automatically ends local access when an online Mac receives its
signed removal, without restarting the app. Keep both signed, notarized installers
here, outside the public website:

- `photodepot-0.2.4-arm64.dmg`
- `photodepot-0.2.4-x64.dmg`

DMGs are ignored by Git. `pnpm downloads:upload` uploads them to the private R2
bucket, and `pnpm downloads:upload:local` seeds local development storage.
Versioned object keys and `DOWNLOADS_ENABLED` are defined in `lib/download-files.ts`;
update the mapping and re-enable downloads when releasing new builds. Upload before
deploying an updated mapping. The uploader refuses releases while downloads are paused.
The public `/api/download/arm64` and `/api/download/x64` endpoints stream downloads
using the R2 binding without a password. Keep public bucket access disabled.
Website builds fail if an installer appears in `public/` or `out/`.
