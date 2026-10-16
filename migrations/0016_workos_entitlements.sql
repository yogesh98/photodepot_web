-- WorkOS owns Stripe entitlement reconciliation; these rows hold authenticated proof.
CREATE TABLE workos_billing_sessions (
  user_id TEXT PRIMARY KEY REFERENCES stripe_customers(user_id),
  session_id TEXT UNIQUE NOT NULL,
  encrypted_tokens TEXT NOT NULL,
  operation_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  reauth_needed INTEGER NOT NULL DEFAULT 0 CHECK (reauth_needed IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workos_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES stripe_customers(user_id),
  organization_id TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT;
