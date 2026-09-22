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

/** Catch the paste mistakes that otherwise surface as unrelated errors. */
function assertUsableUrl(url) {
  if (/\[YOUR-PASSWORD\]/i.test(url)) {
    throw new Error(
      'DATABASE_URL still contains the [YOUR-PASSWORD] placeholder. Replace it — brackets included — with your database password.'
    );
  }
  let password = '';
  try {
    // URL() percent-encodes what it parses, so decode before inspecting.
    password = decodeURIComponent(new URL(url).password);
  } catch {
    throw new Error(`DATABASE_URL is not a valid connection string. It should look like postgresql://user:password@host:5432/dbname`);
  }
  if (/^\[.*\]$/.test(password)) {
    throw new Error(
      'The password in DATABASE_URL is wrapped in square brackets. Those only marked where to type — remove them.'
    );
  }
  if ((url.match(/@/g) || []).length > 1) {
    throw new Error(
      'DATABASE_URL contains more than one "@". If your password has an @ in it, write it as %40 (also : → %3A, / → %2F, # → %23).'
    );
  }
}

/**
 * Turn a driver error into something that names the likely cause. This runs in
 * the deploy log, which is often the only diagnostic a person can reach when
 * the service won't start.
 */
function explainConnectionError(error, url) {
  let user = '';
  let host = '';
  let rawPassword = '';
  try {
    const parsed = new URL(url);
    user = decodeURIComponent(parsed.username);
    host = parsed.hostname;
    rawPassword = parsed.password;
  } catch {
    /* fall through to the raw error */
  }

  const message = String(error.message || '');
  const isPooler = /pooler\.supabase\.com$/i.test(host);
  const hints = [];

  if (/password|authentication|SASL/i.test(message)) {
    if (isPooler && !user.includes('.')) {
      hints.push(
        `The username "${user}" is wrong for a Supabase pooler: it needs to be "postgres.<your-project-ref>", not plain "postgres".`,
        'Copy the Session pooler string fresh from Supabase (Connect → Session pooler) rather than editing the direct-connection one.'
      );
    } else if (/%25/.test(rawPassword)) {
      // %25 is an encoded '%'. Legitimate if the password really contains one,
      // but far more often it means an already-encoded string got encoded again.
      hints.push(
        'The password looks double-encoded: it contains "%25", which is an encoded "%".',
        'If your password has $ in it, "%24" is already correct — do not encode it again.',
        'Paste the connection string exactly as your provider shows it, changing only the password.'
      );
    } else {
      hints.push(
        'The server rejected the username or password.',
        'If the password contains @ : / or #, percent-encode it (@ becomes %40), or reset it in your provider\'s dashboard.',
        'Characters like $ ! * - _ need no encoding at all.'
      );
    }
  } else if (/ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    hints.push(
      `Could not reach ${host} over the network.`,
      'On Supabase this usually means the "Direct connection" string, which is IPv6-only. Use the Session pooler instead.'
    );
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    hints.push(`The hostname "${host}" does not resolve. Check it for typos.`);
  } else if (/does not exist/i.test(message)) {
    hints.push('That database does not exist on the server named in DATABASE_URL.');
  }

  if (!hints.length) return error;

  const enriched = new Error(`${message}\n  ${hints.join('\n  ')}`);
  enriched.cause = error;
  return enriched;
}

export async function initDb() {
  if (driver !== 'none') return;

  if (config.databaseUrl) {
    assertUsableUrl(config.databaseUrl);
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

    // Connect once up front so a bad connection string is explained here,
    // rather than surfacing later as an opaque failure mid-request.
    try {
      const probe = await pool.connect();
      probe.release();
    } catch (error) {
      await pool.end().catch(() => {});
      pool = null;
      throw explainConnectionError(error, config.databaseUrl);
    }

    driver = 'postgres';
  } else {
    // Falling back to the embedded database in production would "work" while
    // silently writing every shift to a disk the host wipes on redeploy.
    // Refuse instead: a deploy that fails loudly beats data that vanishes.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DATABASE_URL is not set. Production needs a Postgres connection string — ' +
          'without one the app would store shifts locally and lose them on the next deploy. ' +
          'Set DATABASE_URL, then redeploy. Run `npm run check-db` to test a connection string.'
      );
    }
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
      last_login_at TEXT,
      locations TEXT NOT NULL DEFAULT '[]'
    )`);
  // Added after the first release. An empty list means every location, which
  // is what existing accounts had implicitly.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locations TEXT NOT NULL DEFAULT '[]'`);

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
      template_key TEXT NOT NULL DEFAULT 'opening',
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
  // Added after the first release; existing rows are all opening logs.
  await query("ALTER TABLE shifts ADD COLUMN IF NOT EXISTS template_key TEXT NOT NULL DEFAULT 'opening'");

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
