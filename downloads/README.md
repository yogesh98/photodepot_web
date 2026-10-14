# Photodepot installers

Keep the installers here, outside the public website:

- `photodepot-0.1.6-arm64.dmg`
- `photodepot-0.1.6-x64.dmg`

DMGs are ignored by Git. `pnpm downloads:upload` uploads them to the private R2
bucket, and `pnpm downloads:upload:local` seeds local development storage.
Versioned object keys are defined in `lib/download-files.ts`; update that mapping
when releasing new builds. Upload before deploying an updated mapping.
The public `/api/download/arm64` and `/api/download/x64` endpoints stream downloads
using the R2 binding without a password. Keep public bucket access disabled.
Website builds fail if an installer appears in `public/` or `out/`.
