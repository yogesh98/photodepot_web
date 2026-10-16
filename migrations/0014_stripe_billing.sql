-- Stripe has its own payment ledger. Manual grants and their audit history stay intact.
CREATE TABLE stripe_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT UNIQUE,
  workos_organization_id TEXT UNIQUE,
  trial_used INTEGER NOT NULL DEFAULT 0 CHECK (trial_used IN (0, 1)),
  customer_create_token TEXT NOT NULL,
  customer_create_started_at INTEGER,
  checkout_session_id TEXT UNIQUE,
  checkout_expires_at INTEGER,
  checkout_price_id TEXT,
  checkout_started_at INTEGER,
  checkout_trial_days INTEGER,
  checkout_generation INTEGER NOT NULL DEFAULT 0,
  operation_token TEXT,
  operation_lease_until INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE stripe_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES stripe_customers(user_id),
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  price_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL CHECK (starts_at >= 0),
  -- Confirmed paid invoice periods or a confirmed Stripe trial, in milliseconds.
  -- current_period_end alone is never evidence that a renewal was paid.
  access_ends_at INTEGER NOT NULL CHECK (access_ends_at >= 0),
  paid_through_at INTEGER NOT NULL DEFAULT 0 CHECK (paid_through_at >= 0),
  trial_ends_at INTEGER,
  cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1)),
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;
CREATE INDEX stripe_subscriptions_user ON stripe_subscriptions(user_id, starts_at DESC);
CREATE UNIQUE INDEX stripe_subscriptions_one_open ON stripe_subscriptions(user_id)
  WHERE status NOT IN ('canceled', 'incomplete_expired');

CREATE TABLE stripe_webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER NOT NULL
) STRICT;
