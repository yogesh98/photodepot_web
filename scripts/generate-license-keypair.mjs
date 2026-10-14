import { generateKeyPairSync } from "node:crypto"
import { realpath, writeFile } from "node:fs/promises"
import path from "node:path"

const suppliedDestination = process.argv[2]
if (!suppliedDestination || !path.isAbsolute(suppliedDestination)) {
  console.error(
    "Usage: node scripts/generate-license-keypair.mjs /absolute/path/outside-repo/license-signing-private-key.txt"
  )
  process.exit(1)
}
const destination = path.join(
  await realpath(path.dirname(suppliedDestination)),
  path.basename(suppliedDestination)
)
const repository = await realpath(path.resolve(import.meta.dirname, ".."))
if (
  destination === repository ||
  destination.startsWith(`${repository}${path.sep}`)
) {
  console.error("Save the private key outside this repository.")
  process.exit(1)
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const encoded = privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64")
await writeFile(destination, `${encoded}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
})
console.log(
  `Private key saved with owner-only permissions to ${destination}. Keep it in a secure backup; do not commit it.`
)
console.log(
  `PHOTODEPOT_LICENSE_PUBLIC_KEY=${publicKey.export({ format: "der", type: "spki" }).toString("base64url")}`
)
