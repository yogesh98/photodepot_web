import type { Metadata } from "next"
import localFont from "next/font/local"

import "./globals.css"
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
})

export const metadata: Metadata = {
  title: "photodepot",
  description:
    "Ingest, cull, organize, and export photos and video in one local workspace for Mac. Review together on the same network.",
  robots: { index: false, follow: false },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${inter.variable} antialiased`}>
      <body>{children}</body>
    </html>
  )
}
