# PhotoDepot installers

Drop the builds into this folder with these exact names:

- Apple Silicon: `photodepot-0.1.0-arm64.dmg`
- Intel Mac: `photodepot-0.1.0-x64.dmg`

DMGs are ignored by Git. Upload both files here when deploying.
The mapping is in `lib/download-files.ts`; update it when changing filenames.
Direct `/downloads/` URLs are blocked by `proxy.ts`. Files are streamed from the
password-protected `/api/download/arm64` and `/api/download/x64` endpoints.
Serve this folder through Next.js, not a separate static server or public CDN.
