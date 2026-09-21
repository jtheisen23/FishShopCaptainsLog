import express from 'express';
import {
  findUserByEmail,
  verifyPassword,
  createSession,
  destroySession,
  destroyAllSessionsForUser,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
  recordLogin,
  loginBlocked,
  recordFailedLogin,
  clearLoginAttempts,
  passwordProblem,
  hashPassword,
  normalizeEmail,
} from '../auth.js';
import { db, logEvent } from '../db.js';
import { ah, fail } from './helpers.js';

export const authRouter = express.Router();

authRouter.post(
  '/login',
  ah((req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const throttleKey = `${req.ip}|${email}`;

    if (!email || !password) fail(400, 'Enter your email and password.');
    if (loginBlocked(throttleKey)) {
      fail(429, 'Too many attempts. Wait 15 minutes and try again.');
    }

    const user = findUserByEmail(email);
    // Same message either way, so the form can't be used to enumerate staff.
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      recordFailedLogin(throttleKey);
      fail(401, 'That email and password combination did not work.');
    }

    clearLoginAttempts(throttleKey);
    const { token, expires } = createSession(user.id, req.headers['user-agent'] || '');
    setSessionCookie(res, token, expires);
    recordLogin(user, req);

    res.json({ user: publicUser(user) });
  })
);

authRouter.post(
  '/logout',
  ah((req, res) => {
    destroySession(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

authRouter.get(
  '/me',
  ah((req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

authRouter.post(
  '/password',
  ah((req, res) => {
    if (!req.user) fail(401, 'Sign in to continue.');

    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');

    if (!verifyPassword(current, req.user.password_hash)) fail(400, 'Your current password is not right.');
    const problem = passwordProblem(next);
    if (problem) fail(400, problem);

    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      hashPassword(next),
      req.user.id
    );
    logEvent({ userId: req.user.id, type: 'password_changed' });

    // Sign every other device out, then re-issue this one.
    destroyAllSessionsForUser(req.user.id);
    const { token, expires } = createSession(req.user.id, req.headers['user-agent'] || '');
    setSessionCookie(res, token, expires);

    res.json({ ok: true });
  })
);
