import crypto from 'node:crypto';
import { query, one, all, nowIso, logEvent } from './db.js';
import { config } from './config.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Minimum bar for a password. Returns an error string, or null when fine. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) return 'Password is too long.';
  return null;
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const ROLES = ['staff', 'manager', 'admin'];
const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export async function createUser({ email, name, password, role = 'staff', mustChangePassword = false }) {
  const row = await one(
    `INSERT INTO users(email, name, role, password_hash, active, must_change_password, created_at)
     VALUES($1, $2, $3, $4, TRUE, $5, $6) RETURNING id`,
    [normalizeEmail(email), String(name).trim(), role, hashPassword(password), Boolean(mustChangePassword), nowIso()]
  );
  return findUserById(row.id);
}

export async function findUserByEmail(email) {
  return one('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
}

export async function findUserById(id) {
  return one('SELECT * FROM users WHERE id = $1', [id]);
}

export async function listUsers() {
  return all('SELECT * FROM users ORDER BY active DESC, LOWER(name)');
}

export async function countUsers() {
  const row = await one('SELECT COUNT(*)::int AS n FROM users');
  return row.n;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: Boolean(user.active),
    mustChangePassword: Boolean(user.must_change_password),
    lastLoginAt: user.last_login_at,
  };
}

export function hasRole(user, minimum) {
  return Boolean(user) && (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[minimum] || 99);
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(userId, userAgent = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await query(
    'INSERT INTO sessions(token_hash, user_id, created_at, expires_at, user_agent) VALUES($1, $2, $3, $4, $5)',
    [hashToken(token), userId, nowIso(), expires.toISOString(), String(userAgent).slice(0, 300)]
  );
  return { token, expires };
}

export async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function destroyAllSessionsForUser(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export async function userForToken(token) {
  if (!token) return null;
  const row = await one(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = TRUE`,
    [hashToken(token), nowIso()]
  );
  return row || null;
}

export async function purgeExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at <= $1', [nowIso()]);
}

/* ------------------------------------------------------------------ *
 * Login throttling (in-memory; resets on restart, which is fine here)
 * ------------------------------------------------------------------ */

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60_000;

export function loginBlocked(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedLogin(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function clearLoginAttempts(key) {
  attempts.delete(key);
}

/* ------------------------------------------------------------------ *
 * Express middleware
 * ------------------------------------------------------------------ */

export async function attachUser(req, _res, next) {
  try {
    const token = req.cookies?.[config.sessionCookie];
    req.sessionToken = token || null;
    req.user = await userForToken(token);
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireRole(minimum) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!hasRole(req.user, minimum)) {
      return res.status(403).json({ error: `This action needs ${minimum} access.` });
    }
    next();
  };
}

export function setSessionCookie(res, token, expires) {
  res.cookie(config.sessionCookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    expires,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
  });
}

export async function recordLogin(user, req) {
  await query('UPDATE users SET last_login_at = $1 WHERE id = $2', [nowIso(), user.id]);
  await logEvent({
    userId: user.id,
    type: 'user_signed_in',
    detail: String(req.headers['user-agent'] || '').slice(0, 200),
  });
}
