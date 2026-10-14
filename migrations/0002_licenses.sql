CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_suffix TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('trial', 'regular')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  current_device_id TEXT,
  binding_revision INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_verified_at INTEGER
) STRICT;
CREATE INDEX licenses_created ON licenses (created_at DESC, id DESC);
CREATE TABLE license_devices (
  device_id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  public_key TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  activated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX license_devices_license ON license_devices (license_id);
CREATE TABLE license_audit (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL
) STRICT;
CREATE INDEX license_audit_license ON license_audit (license_id, created_at DESC);
CREATE TABLE license_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX license_attempts_expiry ON license_attempts (expires_at);
