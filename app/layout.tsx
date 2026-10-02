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
    "Cull and organize photographs together in PhotoDepot. One Mac hosts; approved reviewers join from their own Macs on the same local network, with changes shared across the project.",
  robots: { index: false, follow: false },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${inter.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  )
}
