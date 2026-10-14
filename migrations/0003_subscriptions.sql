-- Account creation does not grant access. Only an explicit administrator action
-- inserts a subscription. Existing license and waitlist data remain unchanged.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('trial', 'regular')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  end_at INTEGER NOT NULL CHECK (end_at > started_at AND end_at <= 8640000000000000),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
) STRICT;

CREATE TABLE subscription_audit (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  action TEXT NOT NULL CHECK (action IN ('set', 'revoke', 'restore', 'extend', 'bind-device', 'reset-device')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL
) STRICT;
CREATE INDEX subscription_audit_subscription
  ON subscription_audit (subscription_id, created_at DESC, id DESC);
