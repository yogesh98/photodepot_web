-- Account sessions authorize application use independently of subscriptions.
-- Keep revoked sessions so old device proofs can receive signed revocation.
CREATE TABLE desktop_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  public_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  revocation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX desktop_sessions_active_device ON desktop_sessions(device_id) WHERE active = 1;
CREATE INDEX desktop_sessions_user ON desktop_sessions(user_id, active);
ALTER TABLE account_pairings ADD COLUMN account_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_pairings ADD COLUMN session_id TEXT;
ALTER TABLE account_pairings ADD COLUMN intent TEXT NOT NULL DEFAULT 'login';

-- Administration resets revoke the same sessions as desktop logout and the
-- customer console. Subscription revocation/expiry alone never logs users out.
CREATE TRIGGER desktop_sessions_account_reset AFTER UPDATE OF binding_revision ON subscriptions
WHEN NEW.binding_revision != OLD.binding_revision
BEGIN
  UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = NEW.updated_at
    WHERE user_id = NEW.user_id AND active = 1;
  UPDATE account_pairings SET status = 'cancelled' WHERE user_id = NEW.user_id AND account_version = 1;
END;
CREATE TRIGGER desktop_sessions_device_reset AFTER UPDATE OF active ON account_devices
WHEN NEW.active = 0 AND OLD.active = 1
BEGIN
  UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id AND active = 1;
  UPDATE account_pairings SET status = 'cancelled' WHERE user_id = NEW.user_id AND device_id = NEW.device_id AND account_version = 1;
END;
