import type { Metadata } from "next"
import localFont from "next/font/local"

import "./globals.css"
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
})

const description =
  "Cull and organize photographs together in Photodepot. One Mac hosts; approved reviewers join from their own Macs on the same local network, with changes shared across the project."
const shareImage = {
  url: "/brand/photodepot.png",
  width: 1024,
  height: 1024,
  alt: "Photodepot app logo",
}

export const metadata: Metadata = {
  title: "photodepot",
  description,
  openGraph: {
    title: "photodepot",
    description,
    siteName: "photodepot",
    type: "website",
    images: [shareImage],
  },
  twitter: {
    card: "summary",
    title: "photodepot",
    description,
    images: [shareImage],
  },
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
