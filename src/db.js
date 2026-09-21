/**
 * Data layer. One SQL dialect (PostgreSQL), two transports:
 *
 *   - DATABASE_URL set  → a real Postgres server (Neon, Supabase, RDS…).
 *     This is what production uses, and it's why the app needs no disk.
 *   - DATABASE_URL unset → PGlite, genuine Postgres compiled to WebAssembly,
 *     running in-process against a local folder. Zero setup for development
 *     and tests; the SQL is identical to production.
 *
 * Everything here is async. Call `initDb()` once before serving.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let pool = null;          // pg Pool, in production
let pglite = null;        // PGlite instance, in development
export let driver = 'none';

/** Normalise both drivers to `{ rows }`. */
function wrap(client) {
  return {
    query: async (sql, params = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows ?? [] };
    },
  };
}

export async function initDb() {
  if (driver !== 'none') return;

  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      // Hosted Postgres (Neon, Supabase, Render) requires TLS. Their certs are
      // publicly trusted, but some platforms' chains don't verify from inside
      // a container, so allow the documented opt-out rather than having people
      // disable TLS entirely.
      ssl: config.databaseSsl ? { rejectUnauthorized: config.databaseSslStrict } : false,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on('error', (error) => console.error('[postgres pool]', error.message));
    driver = 'postgres';
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(path.dirname(config.pgliteDir), { recursive: true });
    pglite = await PGlite.create(config.pgliteDir);
    driver = 'pglite';
  }

  await migrate();
  await seedDefaultSettings();
}

/** Run a single statement. */
export async function query(sql, params = []) {
  if (driver === 'postgres') return wrap(pool).query(sql, params);
  if (driver === 'pglite') return wrap(pglite).query(sql, params);
  throw new Error('Database not initialised — call initDb() first.');
}

export async function all(sql, params = []) {
  return (await query(sql, params)).rows;
}

export async function one(sql, params = []) {
  return (await query(sql, params)).rows[0];
}

/**
 * Run `fn` inside a transaction, rolling back if it throws. `fn` receives an
 * executor it MUST use for its statements — with a pool, work that goes
 * through `query()` instead would land on a different connection and escape
 * the transaction.
 */
export async function transaction(fn) {
  if (driver === 'pglite') {
    return pglite.transaction(async (tx) => fn(wrap(tx)));
  }
  if (driver !== 'postgres') throw new Error('Database not initialised.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
  if (pglite) { await pglite.close().catch(() => {}); pglite = null; }
  driver = 'none';
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    )`);

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT ''
    )`);
  await query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');

  await query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
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
    )`);
  await query('CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(business_date DESC, location)');

  await query(`
    CREATE TABLE IF NOT EXISTS checks (
      id SERIAL PRIMARY KEY,
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      note TEXT NOT NULL DEFAULT '',
      flagged BOOLEAN NOT NULL DEFAULT FALSE,
      checked_by INTEGER REFERENCES users(id),
      checked_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(shift_id, item_key)
    )`);
  await query('CREATE INDEX IF NOT EXISTS idx_checks_shift ON checks(shift_id)');

  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL,
      item_key TEXT,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`);
  await query('CREATE INDEX IF NOT EXISTS idx_events_shift ON events(shift_id, id)');

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  locations: JSON.stringify(['Point Loma', 'Pacific Beach']),
  shift_types: JSON.stringify(['AM', 'PM']),
  recap_recipients: JSON.stringify([]),
};

async function seedDefaultSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING', [key, value]);
  }
}

export async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

export async function getJsonSetting(key, fallback) {
  const raw = await getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  await query(
    'INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  );
}

export async function setJsonSetting(key, value) {
  await setSetting(key, JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * Running log
 * ------------------------------------------------------------------ */

export const nowIso = () => new Date().toISOString();

export async function logEvent({ shiftId = null, userId = null, type, itemKey = null, detail = '' }, exec = null) {
  const run = exec || { query };
  await run.query(
    'INSERT INTO events(shift_id, user_id, type, item_key, detail, created_at) VALUES($1, $2, $3, $4, $5, $6)',
    [shiftId, userId, type, itemKey, detail, nowIso()]
  );
}
