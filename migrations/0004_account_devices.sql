ALTER TABLE subscriptions ADD COLUMN current_device_id TEXT;
ALTER TABLE subscriptions ADD COLUMN binding_revision INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX subscriptions_current_device
  ON subscriptions (current_device_id) WHERE current_device_id IS NOT NULL;

-- Keep prior device keys after an administrator resets a Mac. Verification can
-- return an authenticated revocation instead of reviving an old license key.
CREATE TABLE account_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES subscriptions(user_id),
  public_key TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  activated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX account_devices_user ON account_devices (user_id);
