import { randomUUID } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import type {
  SubscriptionStatus,
  SubscriptionType,
  SubscriptionSummary,
} from "./subscription-types.ts"

export type AccountRequestAction = "renewal" | "reset-device"
export type AccountRequestStatus =
  "pending" | "acknowledged" | "resolved" | "rejected"
export interface CustomerRequest {
  id: string
  action: AccountRequestAction
  deviceId: string | null
  message: string
  status: AccountRequestStatus
  createdAt: number
  updatedAt: number
}
export interface AccountRequest extends CustomerRequest {
  userId: string
  email: string
  revision: number
  adminNote: string
  handledBy: string
}
export interface AccountRequestAudit {
  id: string
  action: string
  actor: string
  createdAt: number
  note: string
}
export interface CustomerSubscription {
  type: SubscriptionType
  status: SubscriptionStatus
  startsAt: number
  endsAt: number
  deviceLimit: number
  devices: { id: string; activatedAt: number }[]
}
export interface CustomerAccount {
  environment: "production" | "development"
  user: { email: string }
  subscription: CustomerSubscription | null
  requests: CustomerRequest[]
}
export interface AdminRequestQueue {
  environment: "production" | "development"
  requests: (AccountRequest & { subscription: SubscriptionSummary | null })[]
  openCount: number
  limit: number
}
interface RequestRow {
  id: string
  user_id: string
  account_email: string
  action: AccountRequestAction
  device_id: string
  message: string
  status: AccountRequestStatus
  revision: number
  created_at: number
  updated_at: number
  admin_note: string
  handled_by: string
}
export class AccountRequestConflictError extends Error {
  constructor() {
    super("This request changed. Refresh the queue before reviewing it again.")
  }
}
export class AccountRequestLimitError extends Error {
  constructor() {
    super(
      "You can submit up to 5 new requests in 24 hours. Please try again later."
    )
  }
}
export const ACCOUNT_REQUEST_ID = /^request_[a-f0-9-]{36}$/
function userId(value: string) {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^user_[A-Za-z0-9_]+$/.test(value)
  )
    throw new TypeError("Invalid account.")
}
function text(value: unknown, label: string, limit = 1000) {
  if (typeof value !== "string" || value.length > limit)
    throw new TypeError(
      `Enter ${label} of at most ${limit.toLocaleString("en-US")} characters.`
    )
  return value.trim()
}
function summary(row: RequestRow): AccountRequest {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.account_email,
    action: row.action,
    deviceId: row.device_id || null,
    message: row.message,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    adminNote: row.admin_note,
    handledBy: row.handled_by,
  }
}
export function customerRequest(request: AccountRequest): CustomerRequest {
  return {
    id: request.id,
    action: request.action,
    deviceId: request.deviceId,
    message: request.message,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  }
}
export async function getAccountRequest(
  database: D1Database,
  id: string
): Promise<AccountRequest | null> {
  if (!ACCOUNT_REQUEST_ID.test(id)) throw new TypeError("Invalid request.")
  const row = await database
    .prepare("SELECT * FROM subscription_requests WHERE id = ?")
    .bind(id)
    .first<RequestRow>()
  return row ? summary(row) : null
}
export async function listAccountRequests(
  database: D1Database,
  accountId: string
): Promise<CustomerRequest[]> {
  userId(accountId)
  const rows = await database
    .prepare(
      "SELECT * FROM subscription_requests WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"
    )
    .bind(accountId)
    .all<RequestRow>()
  return rows.results.map((row) => customerRequest(summary(row)))
}
export async function listAdminRequests(
  database: D1Database,
  includeClosed = false
) {
  const where = includeClosed
    ? ""
    : "WHERE status IN ('pending', 'acknowledged')"
  const [rows, count] = await Promise.all([
    database
      .prepare(
        `SELECT * FROM subscription_requests ${where} ORDER BY created_at ASC, id ASC LIMIT 100`
      )
      .all<RequestRow>(),
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM subscription_requests WHERE status IN ('pending', 'acknowledged')"
      )
      .first<{ count: number }>(),
  ])
  return {
    requests: rows.results.map(summary),
    openCount: count?.count ?? 0,
    limit: 100,
  }
}
export async function listRequestAudit(database: D1Database, id: string) {
  if (!ACCOUNT_REQUEST_ID.test(id)) throw new TypeError("Invalid request.")
  const rows = await database
    .prepare(
      "SELECT id, action, actor, created_at AS createdAt, note FROM subscription_request_audit WHERE request_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"
    )
    .bind(id)
    .all<AccountRequestAudit>()
  return rows.results
}
export async function createAccountRequest(
  database: D1Database,
  input: {
    userId: string
    email: string
    action: AccountRequestAction
    deviceId?: string
    message?: string
  },
  now = Date.now()
) {
  userId(input.userId)
  const email = text(input.email, "an account email", 320)
  if (!email || !["renewal", "reset-device"].includes(input.action))
    throw new TypeError("Invalid account request.")
  const deviceId = input.deviceId ?? ""
  if (
    input.action === "renewal"
      ? deviceId !== ""
      : !/^[a-f0-9]{64}$/.test(deviceId)
  )
    throw new TypeError("Choose a current Mac assignment.")
  const message = text(input.message ?? "", "a message")
  if (!Number.isSafeInteger(now) || now < 0)
    throw new TypeError("Invalid request time.")
  const id = `request_${randomUUID()}`
  await database.batch([
    database
      .prepare(
        `INSERT INTO subscription_requests (id,user_id,account_email,action,device_id,message,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM subscription_requests WHERE user_id = ? AND created_at > ?) < 5
      ON CONFLICT DO NOTHING`
      )
      .bind(
        id,
        input.userId,
        email,
        input.action,
        deviceId,
        message,
        now,
        now,
        input.userId,
        now - 86_400_000
      ),
    database
      .prepare(
        `INSERT INTO subscription_request_audit (id,request_id,action,actor,created_at)
      SELECT ?, id, 'created', account_email, ? FROM subscription_requests WHERE id = ?`
      )
      .bind(randomUUID(), now, id),
  ])
  const created = await getAccountRequest(database, id)
  if (created) return { request: customerRequest(created), created: true }
  const existing = await database
    .prepare(
      "SELECT * FROM subscription_requests WHERE user_id = ? AND action = ? AND device_id = ? AND status IN ('pending', 'acknowledged')"
    )
    .bind(input.userId, input.action, deviceId)
    .first<RequestRow>()
  if (existing)
    return { request: customerRequest(summary(existing)), created: false }
  throw new AccountRequestLimitError()
}
export async function reviewAccountRequest(
  database: D1Database,
  input: {
    id: string
    action: "acknowledge" | "resolve" | "reject"
    expectedRevision: number
    note?: string
  },
  actor: string,
  now = Date.now()
) {
  if (
    !ACCOUNT_REQUEST_ID.test(input.id) ||
    !["acknowledge", "resolve", "reject"].includes(input.action) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    throw new TypeError("Invalid request review.")
  const note = text(input.note ?? "", "an admin review note")
  const administrator = text(actor, "an administrator", 320)
  if (!administrator || !Number.isSafeInteger(now) || now < 0)
    throw new TypeError("Invalid request review.")
  const nextStatus =
    input.action === "acknowledge"
      ? "acknowledged"
      : input.action === "resolve"
        ? "resolved"
        : "rejected"
  const permitted =
    input.action === "acknowledge"
      ? "status = 'pending'"
      : "status IN ('pending', 'acknowledged')"
  const results = await database.batch([
    database
      .prepare(
        `UPDATE subscription_requests SET status=?, revision=revision+1, updated_at=?, admin_note=?, handled_by=? WHERE id=? AND revision=? AND ${permitted} RETURNING *`
      )
      .bind(
        nextStatus,
        now,
        note,
        administrator,
        input.id,
        input.expectedRevision
      ),
    database
      .prepare(
        `INSERT INTO subscription_request_audit (id,request_id,action,actor,created_at,note)
      SELECT ?,id,?,?,?,? FROM subscription_requests WHERE id=? AND revision=? AND updated_at=? AND status=? AND changes()=1`
      )
      .bind(
        randomUUID(),
        input.action,
        administrator,
        now,
        note,
        input.id,
        input.expectedRevision + 1,
        now,
        nextStatus
      ),
  ])
  const row = results[0].results[0] as RequestRow | undefined
  if (!row) throw new AccountRequestConflictError()
  return summary(row)
}
