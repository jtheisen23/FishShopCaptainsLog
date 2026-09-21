/**
 * Take a consistent copy of the database while the app is running.
 *
 *   npm run backup                      → ./backups/captains-log-2026-09-21.db
 *   npm run backup /var/data/copy.db    → that exact path
 *
 * Uses SQLite's own online-backup, which is the safe way to do this on a live
 * database — plain `cp` can catch the file mid-write and produce a copy that
 * won't open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { config } from '../src/config.js';

const source = config.dbPath;

if (!fs.existsSync(source)) {
  console.error(`No database at ${source}. Is DB_PATH set correctly?`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const target = process.argv[2] || path.join(path.dirname(source), '..', 'backups', `captains-log-${stamp}.db`);

fs.mkdirSync(path.dirname(target), { recursive: true });

const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
} finally {
  db.close();
}

const { size } = fs.statSync(target);
console.log(`Backed up ${source}`);
console.log(`        → ${target} (${(size / 1024).toFixed(0)} KB)`);
