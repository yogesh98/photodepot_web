-- Keep the existing manual subscriptions and audit history. A first signup trial
-- is insert-only, so it cannot replace an administrator's decision or restart.
ALTER TABLE subscriptions ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000);
CREATE INDEX subscriptions_expiration ON subscriptions (status, end_at);

ALTER TABLE subscription_audit RENAME TO subscription_audit_previous;
CREATE TABLE subscription_audit (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  action TEXT NOT NULL CHECK (action IN ('set', 'revoke', 'restore', 'extend', 'bind-device', 'reset-device', 'initial-trial', 'update-notes')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000)
) STRICT;
INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail)
  SELECT id, subscription_id, action, actor, created_at, detail FROM subscription_audit_previous;
DROP TABLE subscription_audit_previous;
CREATE INDEX subscription_audit_subscription
  ON subscription_audit (subscription_id, created_at DESC, id DESC);
