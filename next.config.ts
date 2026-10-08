import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  headers() {
    return [
      {
        // Only content-hashed demo assets can be cached for a year safely.
        source:
          "/screenshots/:name([a-z-]+).:hash([a-f0-9]{12}).:extension(gif|png|webp|mp4)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ]
  },
  redirects() {
    return ["daylight", "cinema", "darkroom"].map((concept) => ({
      source: `/concepts/${concept}`,
      destination: "/",
      permanent: true,
    }))
  },
}

export default nextConfig
