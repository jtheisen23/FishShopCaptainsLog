import express from 'express';
import {
  requireRole,
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  publicUser,
  hashPassword,
  passwordProblem,
  destroyAllSessionsForUser,
  normalizeEmail,
  normalizeLocations,
  ROLES,
} from '../auth.js';
import { query, logEvent, getJsonSetting, setJsonSetting, getSetting, setSetting } from '../db.js';
import { parseRecipients, verifyMailTransport } from '../mail.js';
import { ah, fail } from './helpers.js';

export const adminRouter = express.Router();

adminRouter.use(requireRole('admin'));

/* ---------------------------------- users --------------------------------- */

/**
 * Validate an assignment against the locations that actually exist. An empty
 * list is meaningful: it means every location, now and in the future.
 */
async function checkLocations(input) {
  if (input === undefined || input === null) return [];
  const cleaned = normalizeLocations(input);
  if (!cleaned.length) return [];

  const configured = await getJsonSetting('locations', []);
  const unknown = cleaned.filter((location) => !configured.includes(location));
  if (unknown.length) fail(400, `Not a location you have: ${unknown.join(', ')}`);
  return cleaned;
}

adminRouter.get(
  '/users',
  ah(async (_req, res) => {
    const users = await listUsers();
    res.json({ users: users.map(publicUser) });
  })
);

adminRouter.post(
  '/users',
  ah(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'staff');
    const password = String(req.body?.password || '');
    const assigned = await checkLocations(req.body?.locations);

    if (!email.includes('@')) fail(400, 'Enter a valid email address.');
    if (!name) fail(400, 'Enter a name.');
    if (!ROLES.includes(role)) fail(400, 'Pick a valid role.');
    const problem = passwordProblem(password);
    if (problem) fail(400, problem);
    if (await findUserByEmail(email)) fail(409, 'Someone already uses that email.');

    const user = await createUser({
      email,
      name,
      password,
      role,
      mustChangePassword: true,
      locations: assigned,
    });
    await logEvent({ userId: req.user.id, type: 'user_created', detail: `${name} <${email}> as ${role}` });
    res.status(201).json({ user: publicUser(user) });
  })
);

adminRouter.patch(
  '/users/:id',
  ah(async (req, res) => {
    const user = await findUserById(Number(req.params.id));
    if (!user) fail(404, 'No such user.');

    const changes = [];

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      await query('UPDATE users SET name = $1 WHERE id = $2', [req.body.name.trim(), user.id]);
      changes.push('name');
    }

    if (typeof req.body?.role === 'string') {
      if (!ROLES.includes(req.body.role)) fail(400, 'Pick a valid role.');
      if (user.id === req.user.id && req.body.role !== 'admin') {
        fail(400, 'You cannot remove your own admin access.');
      }
      await query('UPDATE users SET role = $1 WHERE id = $2', [req.body.role, user.id]);
      changes.push(`role → ${req.body.role}`);
    }

    if (typeof req.body?.active === 'boolean') {
      if (user.id === req.user.id && !req.body.active) fail(400, 'You cannot deactivate yourself.');
      await query('UPDATE users SET active = $1 WHERE id = $2', [Boolean(req.body.active), user.id]);
      if (!req.body.active) await destroyAllSessionsForUser(user.id);
      changes.push(req.body.active ? 'reactivated' : 'deactivated');
    }

    if (req.body?.locations !== undefined) {
      const assigned = await checkLocations(req.body.locations);
      await query('UPDATE users SET locations = $1 WHERE id = $2', [JSON.stringify(assigned), user.id]);
      changes.push(assigned.length ? `locations → ${assigned.join(', ')}` : 'locations → all');
    }

    if (typeof req.body?.password === 'string' && req.body.password) {
      const problem = passwordProblem(req.body.password);
      if (problem) fail(400, problem);
      await query('UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2', [
        hashPassword(req.body.password),
        user.id,
      ]);
      await destroyAllSessionsForUser(user.id);
      changes.push('password reset');
    }

    if (!changes.length) fail(400, 'Nothing to update.');
    await logEvent({ userId: req.user.id, type: 'user_updated', detail: `${user.name}: ${changes.join(', ')}` });
    res.json({ user: publicUser(await findUserById(user.id)) });
  })
);

/* -------------------------------- settings -------------------------------- */

adminRouter.get(
  '/settings',
  ah(async (_req, res) => {
    res.json(await readSettings());
  })
);

async function readSettings() {
  const [locations, recapRecipients, logoUrl] = await Promise.all([
    getJsonSetting('locations', []),
    getJsonSetting('recap_recipients', []),
    getSetting('brand_logo_url', ''),
  ]);
  return { locations, recapRecipients, logoUrl };
}

adminRouter.put(
  '/settings',
  ah(async (req, res) => {
    if (Array.isArray(req.body?.locations)) {
      const cleaned = [...new Set(req.body.locations.map((v) => String(v).trim()).filter(Boolean))];
      if (!cleaned.length) fail(400, 'Keep at least one location.');
      await setJsonSetting('locations', cleaned);
    }

    if (req.body?.logoUrl !== undefined) {
      const url = String(req.body.logoUrl || '').trim();
      // A remote image in the app bar: allow an https URL or a path we serve.
      if (url && !/^(https:\/\/|\/)[^\s]+$/i.test(url)) {
        fail(400, 'The logo must be an https:// address, or a path starting with /.');
      }
      await setSetting('brand_logo_url', url);
    }

    if (req.body?.recapRecipients !== undefined) {
      const { valid, invalid } = parseRecipients(req.body.recapRecipients);
      if (invalid.length) fail(400, `These do not look like email addresses: ${invalid.join(', ')}`);
      await setJsonSetting('recap_recipients', valid);
    }

    await logEvent({ userId: req.user.id, type: 'settings_updated' });
    res.json(await readSettings());
  })
);

/** Ask the SMTP server whether our credentials actually work. */
adminRouter.post(
  '/email/test',
  ah(async (_req, res) => {
    res.json(await verifyMailTransport());
  })
);
