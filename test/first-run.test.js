/**
 * The first-admin and break-glass-reset paths. These decide who can get into
 * a deployment, so each branch is pinned down rather than assumed.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscl-firstrun-'));
process.env.PGLITE_DIR = path.join(tmpDir, 'pgdata');
process.env.NODE_ENV = 'test';

const { initDb, closeDb, query } = await import('../src/db.js');
const { maybeSeedFirstAdmin } = await import('../src/first-run.js');
const { findUserByEmail, verifyPassword, createSession, userForToken, countUsers } = await import('../src/auth.js');

before(async () => {
  await initDb();
});

after(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // events.user_id has no cascade — deliberately, so an audit trail can't be
  // silently orphaned — so clear it before the users it refers to.
  await query('DELETE FROM events');
  await query('DELETE FROM sessions');
  await query('DELETE FROM users');
  for (const key of ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_NAME', 'SEED_ADMIN_PASSWORD', 'SEED_ADMIN_RESET']) {
    delete process.env[key];
  }
});

test('does nothing when no seed variables are set', async () => {
  assert.equal(await maybeSeedFirstAdmin(), null);
  assert.equal(await countUsers(), 0);
});

test('creates the first admin on an empty database', async () => {
  process.env.SEED_ADMIN_EMAIL = 'Gm@Fishshop.com';
  process.env.SEED_ADMIN_NAME = 'Gina Marsh';
  process.env.SEED_ADMIN_PASSWORD = 'first-admin-pass';

  const user = await maybeSeedFirstAdmin();
  assert.equal(user.email, 'gm@fishshop.com', 'email should be normalised');
  assert.equal(user.role, 'admin');
  assert.equal(Boolean(user.must_change_password), false, 'you chose this password yourself');
  assert.ok(verifyPassword('first-admin-pass', user.password_hash));
});

test('will not touch anything once an account exists', async () => {
  process.env.SEED_ADMIN_EMAIL = 'gm@fishshop.com';
  process.env.SEED_ADMIN_PASSWORD = 'first-admin-pass';
  await maybeSeedFirstAdmin();

  // A second boot with a different password must NOT change the account.
  process.env.SEED_ADMIN_PASSWORD = 'someone-elses-idea';
  assert.equal(await maybeSeedFirstAdmin(), null);

  const user = await findUserByEmail('gm@fishshop.com');
  assert.ok(verifyPassword('first-admin-pass', user.password_hash), 'the original password must still work');
  assert.equal(await countUsers(), 1);
});

test('SEED_ADMIN_RESET recovers a locked-out admin', async () => {
  process.env.SEED_ADMIN_EMAIL = 'gm@fishshop.com';
  process.env.SEED_ADMIN_PASSWORD = 'forgotten-password';
  const created = await maybeSeedFirstAdmin();

  // They're signed in somewhere, and have lost the password.
  const { token } = await createSession(created.id, 'phone');
  assert.ok(await userForToken(token));

  process.env.SEED_ADMIN_PASSWORD = 'a-brand-new-password';
  process.env.SEED_ADMIN_RESET = 'true';
  const reset = await maybeSeedFirstAdmin();
  assert.equal(reset.id, created.id, 'should reset the same account, not make another');

  const user = await findUserByEmail('gm@fishshop.com');
  assert.ok(verifyPassword('a-brand-new-password', user.password_hash), 'the new password should work');
  assert.ok(!verifyPassword('forgotten-password', user.password_hash), 'the old one should not');
  assert.equal(Boolean(user.must_change_password), false);
  assert.equal(await countUsers(), 1, 'no duplicate account');

  // Existing sessions are cut, so a stolen cookie cannot outlive the reset.
  assert.equal(await userForToken(token), null);
});

test('a reset restores admin access to a demoted or deactivated account', async () => {
  process.env.SEED_ADMIN_EMAIL = 'gm@fishshop.com';
  process.env.SEED_ADMIN_PASSWORD = 'forgotten-password';
  const created = await maybeSeedFirstAdmin();
  await query('UPDATE users SET role = $1, active = FALSE WHERE id = $2', ['staff', created.id]);

  process.env.SEED_ADMIN_PASSWORD = 'a-brand-new-password';
  process.env.SEED_ADMIN_RESET = 'true';
  await maybeSeedFirstAdmin();

  const user = await findUserByEmail('gm@fishshop.com');
  assert.equal(user.role, 'admin');
  assert.equal(Boolean(user.active), true);
});

test('a reset for an unknown account creates nothing', async () => {
  process.env.SEED_ADMIN_EMAIL = 'nobody@fishshop.com';
  process.env.SEED_ADMIN_PASSWORD = 'a-brand-new-password';
  process.env.SEED_ADMIN_RESET = 'true';

  assert.equal(await maybeSeedFirstAdmin(), null);
  assert.equal(await countUsers(), 0, 'reset must not be a back door for creating accounts');
});

test('a weak or malformed value changes nothing', async () => {
  process.env.SEED_ADMIN_EMAIL = 'gm@fishshop.com';
  process.env.SEED_ADMIN_PASSWORD = 'good-enough-password';
  await maybeSeedFirstAdmin();

  process.env.SEED_ADMIN_PASSWORD = 'short';
  process.env.SEED_ADMIN_RESET = 'true';
  assert.equal(await maybeSeedFirstAdmin(), null);

  process.env.SEED_ADMIN_EMAIL = 'not-an-email';
  process.env.SEED_ADMIN_PASSWORD = 'long-enough-password';
  assert.equal(await maybeSeedFirstAdmin(), null);

  const user = await findUserByEmail('gm@fishshop.com');
  assert.ok(verifyPassword('good-enough-password', user.password_hash), 'the original password should survive');
});

test('an incomplete pair of variables does nothing', async () => {
  process.env.SEED_ADMIN_EMAIL = 'gm@fishshop.com';
  assert.equal(await maybeSeedFirstAdmin(), null);
  assert.equal(await countUsers(), 0);
});
