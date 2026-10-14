import assert from "node:assert/strict"
import { createPrivateKey, createPublicKey } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
const run = promisify(execFile)
const script = new URL(
  "../scripts/generate-license-keypair.mjs",
  import.meta.url
).pathname

test("signing-key helper protects private output and prints only the matching public key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "photodepot-signing-test-"))
  const file = join(directory, "private-key.txt")
  try {
    const result = await run(process.execPath, [script, file])
    const encoded = (await readFile(file, "utf8")).trim()
    const privateKey = createPrivateKey({
      key: Buffer.from(encoded, "base64"),
      format: "der",
      type: "pkcs8",
    })
    assert.equal(privateKey.asymmetricKeyType, "ed25519")
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.ok(!result.stdout.includes(encoded))
    const expected = createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64url")
    assert.ok(
      result.stdout.includes(`PHOTODEPOT_LICENSE_PUBLIC_KEY=${expected}`)
    )
    await assert.rejects(run(process.execPath, [script, file]))
    assert.equal((await readFile(file, "utf8")).trim(), encoded)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("signing-key helper refuses relative paths and repository destinations", async () => {
  await assert.rejects(run(process.execPath, [script, "relative-key.txt"]))
  await assert.rejects(
    run(process.execPath, [
      script,
      new URL("../private-signing-key-must-not-exist.txt", import.meta.url)
        .pathname,
    ])
  )
})
