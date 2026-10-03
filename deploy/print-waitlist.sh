#!/usr/bin/env bash
set -euo pipefail

node_bin=/opt/photodepot-node/bin/node
if [[ ! -x "$node_bin" ]]; then
  node_bin=$(command -v node) || { echo 'Node.js 22.18+ is required.' >&2; exit 1; }
fi

# Resolve relative database paths from the same directory as the service.
cd /srv/photodepot/app
"$node_bin" --no-warnings --input-type=module <<'NODE'
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

try {
  if (existsSync('/srv/photodepot/.env')) {
    process.loadEnvFile('/srv/photodepot/.env');
  }
  const path = resolve(process.env.PHOTODEPOT_WAITLIST_DB_PATH || 'data/waitlist.sqlite');
  if (!existsSync(path)) {
    console.log('No waitlist signups yet.');
    process.exit(0);
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'waitlist'").get();
    const rows = table
      ? database.prepare('SELECT id, first_name, last_name, email, heard_about_us, created_at FROM waitlist ORDER BY id').all()
      : [];
    console.log(`Waitlist: ${rows.length} signup${rows.length === 1 ? '' : 's'} (timestamps in UTC)`);
    for (const row of rows) {
      console.log(`\n#${row.id} — ${row.created_at}`);
      console.log(`Name: ${[row.first_name, row.last_name].filter(Boolean).join(' ')}`);
      console.log(`Email: ${row.email}`);
      console.log(`Heard about Photodepot: ${row.heard_about_us}`);
    }
  } finally {
    database.close();
  }
} catch (error) {
  console.error(`Could not read the waitlist: ${error.message}`);
  process.exitCode = 1;
}
NODE
