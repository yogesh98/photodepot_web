-- Customer requests never mutate subscriptions or device access. Owners review
-- them separately; active duplicates are prevented inside the database.
CREATE TABLE subscription_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_email TEXT NOT NULL CHECK (length(account_email) <= 320),
  action TEXT NOT NULL CHECK (action IN ('renewal', 'reset-device')),
  device_id TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'resolved', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  admin_note TEXT NOT NULL DEFAULT '' CHECK (length(admin_note) <= 1000),
  handled_by TEXT NOT NULL DEFAULT '',
  CHECK ((action = 'renewal' AND device_id = '') OR (action = 'reset-device' AND length(device_id) = 64))
) STRICT;
CREATE UNIQUE INDEX subscription_requests_active
  ON subscription_requests (user_id, action, device_id)
  WHERE status IN ('pending', 'acknowledged');
CREATE INDEX subscription_requests_queue ON subscription_requests (status, created_at, id);
CREATE INDEX subscription_requests_account ON subscription_requests (user_id, created_at DESC, id DESC);
CREATE TABLE subscription_request_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES subscription_requests(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'acknowledge', 'resolve', 'reject')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000)
) STRICT;
CREATE INDEX subscription_request_audit_request
  ON subscription_request_audit (request_id, created_at DESC, id DESC);
