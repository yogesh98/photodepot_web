-- Preserve the one existing assignment while giving each account two slots.
-- Assignment revisions invalidate a single Mac's approvals without disturbing
-- the other slot; the subscription epoch invalidates all approvals on reset-all.
ALTER TABLE account_devices ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1));
ALTER TABLE account_devices ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 1 CHECK (assignment_revision >= 1);
UPDATE account_devices SET active = 1
  WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = account_devices.user_id
    AND s.current_device_id = account_devices.device_id AND s.binding_revision = account_devices.binding_revision);

DROP INDEX subscriptions_current_device;
ALTER TABLE subscriptions DROP COLUMN current_device_id;
ALTER TABLE account_pairings ADD COLUMN approved_device_revision INTEGER;
UPDATE account_pairings SET approved_device_revision = COALESCE(
  (SELECT d.assignment_revision FROM account_devices d WHERE d.device_id = account_pairings.device_id), 1)
  WHERE status = 'approved';
CREATE INDEX account_devices_active ON account_devices (user_id, active, binding_revision);

-- The API checks capacity inside its transaction; these constraints also protect
-- the invariant if another writer ever inserts or reactivates a device directly.
CREATE TRIGGER account_devices_two_slot_insert BEFORE INSERT ON account_devices
WHEN NEW.active = 1 AND NEW.binding_revision = (SELECT binding_revision FROM subscriptions WHERE user_id = NEW.user_id)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM account_devices d JOIN subscriptions s ON s.user_id = d.user_id
    WHERE d.user_id = NEW.user_id AND d.device_id != NEW.device_id AND d.active = 1 AND d.binding_revision = s.binding_revision) >= 2
    THEN RAISE(ABORT, 'Account already has two connected Macs') END;
END;
CREATE TRIGGER account_devices_two_slot_update BEFORE UPDATE OF active, binding_revision, user_id ON account_devices
WHEN NEW.active = 1 AND NEW.binding_revision = (SELECT binding_revision FROM subscriptions WHERE user_id = NEW.user_id)
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM account_devices d JOIN subscriptions s ON s.user_id = d.user_id
    WHERE d.user_id = NEW.user_id AND d.device_id != NEW.device_id AND d.active = 1 AND d.binding_revision = s.binding_revision) >= 2
    THEN RAISE(ABORT, 'Account already has two connected Macs') END;
END;
