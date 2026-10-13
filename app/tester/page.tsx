import Image from "next/image"
import Link from "next/link"
import { DownloadActions } from "@/components/download-actions"

export default function Page() {
  return (
    <div className="preview-page">
      <header className="site-header">
        <Link href="/" className="wordmark" aria-label="Photodepot home">
          <Image
            src="/brand/photodepot-lockup.svg"
            alt=""
            width={625}
            height={169}
            loading="eager"
          />
        </Link>
      </header>
      <main className="preview-main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-icon">
            <Image
              src="/brand/photodepot-app-icon.png"
              alt="Photodepot app icon"
              width={144}
              height={144}
              preload
            />
          </div>
          <p className="workflow-eyebrow">ingest · cull · organize · deliver</p>
          <h1 id="hero-title">
            Every shoot.
            <br />
            <span>All together.</span>
          </h1>
          <div className="download-section">
            <DownloadActions />
          </div>
        </section>
      </main>
    </div>
  )
}
