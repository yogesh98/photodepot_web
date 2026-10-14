CREATE TABLE subscription_reminders (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  user_id TEXT NOT NULL,
  end_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'trial-ending'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','preview','sent','failed','cancelled','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  first_attempt_at INTEGER,
  recipient TEXT,
  sender TEXT,
  credential_fingerprint TEXT,
  subject TEXT,
  message TEXT,
  provider_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE (subscription_id, end_at, kind)
) STRICT;
CREATE INDEX subscription_reminders_due ON subscription_reminders(status, retry_at, lease_until);
