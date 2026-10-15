ALTER TABLE account_pairings ADD COLUMN device_name TEXT;
ALTER TABLE desktop_sessions ADD COLUMN device_name TEXT;
ALTER TABLE desktop_sessions ADD COLUMN last_used_at INTEGER;
-- Existing records have no reliable device name or last-use timestamp. Leave
-- them unknown until a fresh named sign-in or verified use supplies metadata.

-- Retire foreign legacy assignments shadowed by explicit account-session
-- sign-ins in the previous iteration; they must not reappear on logout.
UPDATE subscriptions SET revision = revision + 1,
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE EXISTS (SELECT 1 FROM account_devices d JOIN desktop_sessions current ON current.device_id = d.device_id
  WHERE d.user_id = subscriptions.user_id AND d.active = 1 AND current.active = 1 AND current.user_id != d.user_id);
UPDATE account_devices SET active = 0, assignment_revision = assignment_revision + 1
WHERE active = 1 AND EXISTS (SELECT 1 FROM desktop_sessions current
  WHERE current.device_id = account_devices.device_id AND current.active = 1 AND current.user_id != account_devices.user_id);
