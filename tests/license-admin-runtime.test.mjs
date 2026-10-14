import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { LICENSE_ADMIN_EMAIL } from "../lib/license-admin-auth.ts"
import { parseCloudflareConfig } from "../scripts/cloudflare-config.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
const origin = "https://photodepot.app"
const issuer = "https://license-runtime-test.cloudflareaccess.com"
const audience = "license-runtime-test-audience"
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const vendor = generateKeyPairSync("ed25519")
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "runtime-test-key",
  alg: "RS256",
  use: "sig",
}
const config = parseCloudflareConfig(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
)
let outputDirectory

before(async () => {
  const temporaryRoot = join(repository, ".wrangler")
  await mkdir(temporaryRoot, { recursive: true })
  outputDirectory = await mkdtemp(join(temporaryRoot, "license-runtime-test-"))
  const wrangler = fileURLToPath(
    new URL("./bin/wrangler.js", import.meta.resolve("wrangler/package.json"))
  )
  // Execute the deployment bundle in workerd: Node fetch mocks do not enforce
  // Workers' supported Request options (including redirect modes).
  await promisify(execFile)(
    process.execPath,
    [
      wrangler,
      "pages",
      "functions",
      "build",
      "--outdir",
      outputDirectory,
      "--compatibility-date",
      config.compatibility_date,
      "--compatibility-flags",
      ...config.compatibility_flags,
    ],
    {
      cwd: repository,
      env: { ...process.env, WRANGLER_LOG_PATH: join(outputDirectory, "logs") },
    }
  )
})

after(async () => {
  if (outputDirectory)
    await rm(outputDirectory, { recursive: true, force: true })
})

function jwt() {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: [audience],
      email: LICENSE_ADMIN_EMAIL,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}

function runtime(t, outboundService, assets = () => new Response("dashboard")) {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      scriptPath: join(outputDirectory, "index.js"),
      modules: true,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      d1Databases: { DB: "license-runtime-test" },
      bindings: {
        PHOTODEPOT_ACCESS_ISSUER: issuer,
        PHOTODEPOT_ACCESS_AUDIENCE: audience,
        PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64"),
      },
      outboundService,
      serviceBindings: { ASSETS: assets },
    })
  )
  t.after(() => worker.dispose())
  return worker
}

test("the built Pages Worker admits a signed administrator and grants licenses", async (t) => {
  const certificateRequests = []
  const worker = runtime(t, (request) => {
    certificateRequests.push(request.url)
    return Response.json({ keys: [jwk] })
  })
  const database = await worker.getD1Database("DB")
  const migration = await readFile(
    new URL("../migrations/0002_licenses.sql", import.meta.url),
    "utf8"
  )
  await database.batch(
    unstable_splitSqlQuery(migration).map((sql) => database.prepare(sql))
  )
  const headers = { "cf-access-jwt-assertion": jwt() }
  const shell = await worker.dispatchFetch(`${origin}/admin/licenses`, {
    headers,
  })
  assert.equal(shell.status, 200)
  assert.equal(await shell.text(), "dashboard")
  assert.equal(shell.headers.get("cache-control"), "private, no-store")
  const granted = await worker.dispatchFetch(`${origin}/api/admin/licenses`, {
    method: "POST",
    headers: { ...headers, origin, "content-type": "application/json" },
    body: JSON.stringify({
      action: "grant",
      type: "trial",
      customerName: "Runtime Tester",
      email: "tester@example.com",
      notes: "",
    }),
  })
  assert.equal(granted.status, 201)
  const result = await granted.json()
  assert.equal(result.license.customerName, "Runtime Tester")
  assert.match(result.key, /^PD-(?:[A-F0-9]{8}-){5}[A-F0-9]{8}$/)
  assert.deepEqual(certificateRequests, [`${issuer}/cdn-cgi/access/certs`])
  const anonymous = await worker.dispatchFetch(`${origin}/admin/licenses`)
  assert.equal(anonymous.status, 401)
})

test("the built Pages Worker rejects redirected certificates without following them", async (t) => {
  const certificateRequests = []
  let servedShell = false
  const worker = runtime(
    t,
    (request) => {
      certificateRequests.push(request.url)
      return request.url === `${issuer}/cdn-cgi/access/certs`
        ? new Response(null, {
            status: 302,
            headers: { Location: "https://redirected.example/certs" },
          })
        : Response.json({ keys: [jwk] })
    },
    () => {
      servedShell = true
      return new Response("dashboard")
    }
  )
  for (const path of ["/admin/licenses", "/api/admin/licenses"]) {
    const response = await worker.dispatchFetch(`${origin}${path}`, {
      headers: { "cf-access-jwt-assertion": jwt() },
    })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  assert.equal(servedShell, false)
  assert.deepEqual(certificateRequests, [
    `${issuer}/cdn-cgi/access/certs`,
    `${issuer}/cdn-cgi/access/certs`,
  ])
})
