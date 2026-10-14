CREATE TABLE account_pairings (
  token_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'cancelled')),
  user_id TEXT,
  approved_binding_revision INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((status = 'approved' AND user_id IS NOT NULL AND approved_binding_revision IS NOT NULL) OR status != 'approved')
) STRICT;
CREATE INDEX account_pairings_expiry ON account_pairings(expires_at);
