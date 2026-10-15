-- Manual renewal preferences do not change the access end date or collect payment.
-- A null timestamp means renewal remains available; a timestamp records an opt-out.
ALTER TABLE subscriptions ADD COLUMN canceled_at INTEGER
  CHECK (canceled_at IS NULL OR (canceled_at >= 0 AND canceled_at <= 8640000000000000));
CREATE INDEX subscriptions_canceled_renewal ON subscriptions (status, canceled_at, end_at);

ALTER TABLE subscription_audit RENAME TO subscription_audit_previous;
CREATE TABLE subscription_audit (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  action TEXT NOT NULL CHECK (action IN ('set', 'revoke', 'restore', 'extend', 'bind-device', 'reset-device', 'initial-trial', 'update-notes', 'cancel-renewal', 'resume-renewal')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000)
) STRICT;
INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail, reason)
  SELECT id, subscription_id, action, actor, created_at, detail, reason FROM subscription_audit_previous;
DROP TABLE subscription_audit_previous;
CREATE INDEX subscription_audit_subscription
  ON subscription_audit (subscription_id, created_at DESC, id DESC);
