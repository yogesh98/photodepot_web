-- This release retires legacy keys and subscription-bound Mac approvals.
-- Keep their rows and historical audit records for Owner review.
ALTER TABLE subscriptions ADD COLUMN reminder_opt_out_at INTEGER
  CHECK (reminder_opt_out_at IS NULL OR reminder_opt_out_at >= 0);
UPDATE subscriptions SET reminder_opt_out_at = canceled_at;
DROP INDEX subscriptions_canceled_renewal;
UPDATE account_pairings SET status = 'cancelled' WHERE account_version = 0;

DROP TRIGGER desktop_sessions_account_reset;
DROP TRIGGER desktop_sessions_device_reset;
DROP TRIGGER account_devices_two_slot_insert;
DROP TRIGGER account_devices_two_slot_update;
DROP TRIGGER account_devices_legacy_insert;
DROP TRIGGER account_devices_legacy_update;
DROP TRIGGER account_devices_clear_legacy_assignment;

-- Device capacity is independent of access grants, including Free accounts.
CREATE TRIGGER desktop_sessions_two_slot_insert BEFORE INSERT ON desktop_sessions
WHEN NEW.active = 1
BEGIN
  SELECT (CASE WHEN (SELECT COUNT(*) FROM desktop_sessions
    WHERE user_id = NEW.user_id AND active = 1 AND device_id != NEW.device_id) >= 2
    THEN RAISE(ABORT, 'Account already has two connected Macs') END);
END;
CREATE TRIGGER desktop_sessions_two_slot_update BEFORE UPDATE OF active, user_id ON desktop_sessions
WHEN NEW.active = 1
BEGIN
  SELECT (CASE WHEN (SELECT COUNT(*) FROM desktop_sessions
    WHERE user_id = NEW.user_id AND active = 1 AND id != NEW.id AND device_id != NEW.device_id) >= 2
    THEN RAISE(ABORT, 'Account already has two connected Macs') END);
END;

ALTER TABLE subscription_audit RENAME TO subscription_audit_previous;
CREATE TABLE subscription_audit (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  action TEXT NOT NULL CHECK (action IN ('set', 'revoke', 'restore', 'extend', 'bind-device', 'reset-device', 'initial-trial', 'update-notes', 'cancel-renewal', 'resume-renewal', 'set-reminders')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000)
) STRICT;
INSERT INTO subscription_audit SELECT * FROM subscription_audit_previous;
DROP TABLE subscription_audit_previous;
CREATE INDEX subscription_audit_subscription ON subscription_audit (subscription_id, created_at DESC, id DESC);

ALTER TABLE subscription_request_audit RENAME TO subscription_request_audit_previous;
CREATE TABLE subscription_request_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES subscription_requests(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'acknowledge', 'resolve', 'reject', 'approve')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000)
) STRICT;
INSERT INTO subscription_request_audit SELECT * FROM subscription_request_audit_previous;
DROP TABLE subscription_request_audit_previous;
CREATE INDEX subscription_request_audit_request ON subscription_request_audit (request_id, created_at DESC, id DESC);

CREATE TABLE account_device_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES desktop_sessions(id),
  action TEXT NOT NULL CHECK (action = 'remove-device'),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000)
) STRICT;
CREATE INDEX account_device_audit_user ON account_device_audit (user_id, created_at DESC, id DESC);
