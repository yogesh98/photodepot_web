-- Stable receipt identity survives manual/Stripe transitions without a desktop update.
CREATE TABLE account_entitlements (
  user_id TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO account_entitlements (user_id,id,revision,fingerprint,updated_at)
SELECT user_id,id,revision,'',updated_at FROM subscriptions;
