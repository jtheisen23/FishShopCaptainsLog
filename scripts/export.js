/**
 * Write every row in the database to a single JSON file — your own copy of the
 * data, independent of whatever your Postgres provider keeps.
 *
 *   npm run export                 → ./backups/captains-log-YYYY-MM-DD.json
 *   npm run export /tmp/mine.json  → that exact path
 *
 * Password hashes and session tokens are deliberately left out: the export is
 * a record of your shifts, not a copy of everyone's credentials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, all } from '../src/db.js';
import { ROOT } from '../src/config.js';

const TABLES = ['users', 'shifts', 'checks', 'events', 'settings'];

const stamp = new Date().toISOString().slice(0, 10);
const target = process.argv[2] || path.join(ROOT, 'backups', `captains-log-${stamp}.json`);

try {
  await initDb();

  const data = { exportedAt: new Date().toISOString(), tables: {} };

  for (const table of TABLES) {
    const rows = await all(`SELECT * FROM ${table} ORDER BY 1`);
    data.tables[table] = table === 'users'
      ? rows.map(({ password_hash, ...safe }) => safe)
      : rows;
    console.log(`  ${table}: ${rows.length} row(s)`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2));

  const { size } = fs.statSync(target);
  console.log(`\nWrote ${target} (${(size / 1024).toFixed(0)} KB)`);
} catch (error) {
  console.error('Export failed:', error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
