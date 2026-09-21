import express from 'express';
import {
  requireRole,
  createUser,
  findUserByEmail,
  findUserById,
  publicUser,
  hashPassword,
  passwordProblem,
  destroyAllSessionsForUser,
  normalizeEmail,
  ROLES,
} from '../auth.js';
import { db, logEvent, getJsonSetting, setJsonSetting } from '../db.js';
import { parseRecipients, verifyMailTransport } from '../mail.js';
import { ah, fail } from './helpers.js';

export const adminRouter = express.Router();

adminRouter.use(requireRole('admin'));

/* ---------------------------------- users --------------------------------- */

adminRouter.get(
  '/users',
  ah((_req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all();
    res.json({ users: users.map(publicUser) });
  })
);

adminRouter.post(
  '/users',
  ah((req, res) => {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'staff');
    const password = String(req.body?.password || '');

    if (!email.includes('@')) fail(400, 'Enter a valid email address.');
    if (!name) fail(400, 'Enter a name.');
    if (!ROLES.includes(role)) fail(400, 'Pick a valid role.');
    const problem = passwordProblem(password);
    if (problem) fail(400, problem);
    if (findUserByEmail(email)) fail(409, 'Someone already uses that email.');

    const user = createUser({ email, name, password, role, mustChangePassword: true });
    logEvent({ userId: req.user.id, type: 'user_created', detail: `${name} <${email}> as ${role}` });
    res.status(201).json({ user: publicUser(user) });
  })
);

adminRouter.patch(
  '/users/:id',
  ah((req, res) => {
    const user = findUserById(Number(req.params.id));
    if (!user) fail(404, 'No such user.');

    const changes = [];

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(req.body.name.trim(), user.id);
      changes.push('name');
    }

    if (typeof req.body?.role === 'string') {
      if (!ROLES.includes(req.body.role)) fail(400, 'Pick a valid role.');
      if (user.id === req.user.id && req.body.role !== 'admin') {
        fail(400, 'You cannot remove your own admin access.');
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, user.id);
      changes.push(`role → ${req.body.role}`);
    }

    if (typeof req.body?.active === 'boolean') {
      if (user.id === req.user.id && !req.body.active) fail(400, 'You cannot deactivate yourself.');
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, user.id);
      if (!req.body.active) destroyAllSessionsForUser(user.id);
      changes.push(req.body.active ? 'reactivated' : 'deactivated');
    }

    if (typeof req.body?.password === 'string' && req.body.password) {
      const problem = passwordProblem(req.body.password);
      if (problem) fail(400, problem);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
        hashPassword(req.body.password),
        user.id
      );
      destroyAllSessionsForUser(user.id);
      changes.push('password reset');
    }

    if (!changes.length) fail(400, 'Nothing to update.');
    logEvent({ userId: req.user.id, type: 'user_updated', detail: `${user.name}: ${changes.join(', ')}` });
    res.json({ user: publicUser(findUserById(user.id)) });
  })
);

/* -------------------------------- settings -------------------------------- */

adminRouter.get(
  '/settings',
  ah((_req, res) => {
    res.json({
      locations: getJsonSetting('locations', []),
      shiftTypes: getJsonSetting('shift_types', []),
      recapRecipients: getJsonSetting('recap_recipients', []),
    });
  })
);

adminRouter.put(
  '/settings',
  ah((req, res) => {
    if (Array.isArray(req.body?.locations)) {
      const cleaned = [...new Set(req.body.locations.map((v) => String(v).trim()).filter(Boolean))];
      if (!cleaned.length) fail(400, 'Keep at least one location.');
      setJsonSetting('locations', cleaned);
    }

    if (Array.isArray(req.body?.shiftTypes)) {
      const cleaned = [...new Set(req.body.shiftTypes.map((v) => String(v).trim()).filter(Boolean))];
      if (!cleaned.length) fail(400, 'Keep at least one shift type.');
      setJsonSetting('shift_types', cleaned);
    }

    if (req.body?.recapRecipients !== undefined) {
      const { valid, invalid } = parseRecipients(req.body.recapRecipients);
      if (invalid.length) fail(400, `These do not look like email addresses: ${invalid.join(', ')}`);
      setJsonSetting('recap_recipients', valid);
    }

    logEvent({ userId: req.user.id, type: 'settings_updated' });
    res.json({
      locations: getJsonSetting('locations', []),
      shiftTypes: getJsonSetting('shift_types', []),
      recapRecipients: getJsonSetting('recap_recipients', []),
    });
  })
);

/** Ask the SMTP server whether our credentials actually work. */
adminRouter.post(
  '/email/test',
  ah(async (_req, res) => {
    res.json(await verifyMailTransport());
  })
);
