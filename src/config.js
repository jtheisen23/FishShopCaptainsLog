import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/** Load a .env file into process.env without pulling in a dependency. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

/**
 * Connection strings get pasted through dashboards, and they arrive with
 * stray quotes, spaces or a trailing newline surprisingly often. None of
 * those are ever meaningful, and each produces a baffling error.
 */
function cleanUrl(value) {
  let url = String(value || '').trim();
  if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
    url = url.slice(1, -1).trim();
  }
  return url;
}

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  port: Number(process.env.PORT || 3000),

  /**
   * Postgres connection string. Set it in production (Neon, Supabase, …) and
   * the app needs no disk of its own. Leave it unset and the app runs an
   * embedded Postgres out of `pgliteDir`, which is what local development and
   * the test suite use.
   */
  databaseUrl: cleanUrl(process.env.DATABASE_URL),
  databaseSsl: bool(process.env.DATABASE_SSL, true),
  /** Set false only if your provider's TLS chain won't verify from your host. */
  databaseSslStrict: bool(process.env.DATABASE_SSL_STRICT, false),
  pgliteDir: process.env.PGLITE_DIR || path.join(ROOT, 'data', 'pgdata'),
  /** Used for links in recap emails. */
  appUrl: (process.env.APP_URL || `http://localhost:${Number(process.env.PORT || 3000)}`).replace(/\/$/, ''),
  /** Business dates and every displayed time are computed in this zone. */
  timezone: process.env.TIMEZONE || 'America/Los_Angeles',
  brandName: process.env.BRAND_NAME || "Fish Shop Captain's Log",
  sessionCookie: 'fscl_session',
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  /** Set true when serving over HTTPS so the session cookie is marked Secure. */
  secureCookies: bool(process.env.SECURE_COOKIES, process.env.NODE_ENV === 'production'),
  trustProxy: bool(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool(process.env.SMTP_SECURE, Number(process.env.SMTP_PORT || 587) === 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  },
};

export const smtpConfigured = Boolean(config.smtp.host && config.smtp.from);
