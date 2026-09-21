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
  ROLES,
} from '../auth.js';
import { query, logEvent, getJsonSetting, setJsonSetting } from '../db.js';
import { parseRecipients, verifyMailTransport } from '../mail.js';
import { ah, fail } from './helpers.js';

export const adminRouter = express.Router();

adminRouter.use(requireRole('admin'));

/* ---------------------------------- users --------------------------------- */

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

    if (!email.includes('@')) fail(400, 'Enter a valid email address.');
    if (!name) fail(400, 'Enter a name.');
    if (!ROLES.includes(role)) fail(400, 'Pick a valid role.');
    const problem = passwordProblem(password);
    if (problem) fail(400, problem);
    if (await findUserByEmail(email)) fail(409, 'Someone already uses that email.');

    const user = await createUser({ email, name, password, role, mustChangePassword: true });
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
  const [locations, shiftTypes, recapRecipients] = await Promise.all([
    getJsonSetting('locations', []),
    getJsonSetting('shift_types', []),
    getJsonSetting('recap_recipients', []),
  ]);
  return { locations, shiftTypes, recapRecipients };
}

adminRouter.put(
  '/settings',
  ah(async (req, res) => {
    if (Array.isArray(req.body?.locations)) {
      const cleaned = [...new Set(req.body.locations.map((v) => String(v).trim()).filter(Boolean))];
      if (!cleaned.length) fail(400, 'Keep at least one location.');
      await setJsonSetting('locations', cleaned);
    }

    if (Array.isArray(req.body?.shiftTypes)) {
      const cleaned = [...new Set(req.body.shiftTypes.map((v) => String(v).trim()).filter(Boolean))];
      if (!cleaned.length) fail(400, 'Keep at least one shift type.');
      await setJsonSetting('shift_types', cleaned);
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
