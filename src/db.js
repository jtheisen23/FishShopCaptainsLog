import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  location TEXT NOT NULL,
  business_date TEXT NOT NULL,
  shift_type TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_by INTEGER REFERENCES users(id),
  opened_at TEXT NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  summary TEXT NOT NULL DEFAULT '',
  recap_sent_at TEXT,
  UNIQUE(location, business_date, shift_type)
);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(business_date DESC, location);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  flagged INTEGER NOT NULL DEFAULT 0,
  checked_by INTEGER REFERENCES users(id),
  checked_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(shift_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_checks_shift ON checks(shift_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  item_key TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_shift ON events(shift_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  locations: JSON.stringify(['Point Loma', 'Pacific Beach']),
  shift_types: JSON.stringify(['AM', 'PM']),
  recap_recipients: JSON.stringify([]),
};

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)').run(key, value);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function getJsonSetting(key, fallback) {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function setJsonSetting(key, value) {
  setSetting(key, JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * Running log
 * ------------------------------------------------------------------ */

export function logEvent({ shiftId = null, userId = null, type, itemKey = null, detail = '' }) {
  db.prepare(
    'INSERT INTO events(shift_id, user_id, type, item_key, detail, created_at) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(shiftId, userId, type, itemKey, detail, nowIso());
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
