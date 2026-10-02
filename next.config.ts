import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  redirects() {
    return ["daylight", "cinema", "darkroom"].map((concept) => ({
      source: `/concepts/${concept}`,
      destination: "/",
      permanent: true,
    }))
  },
}

export default nextConfig
