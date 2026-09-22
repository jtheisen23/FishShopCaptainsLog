import {
  countUsers,
  createUser,
  findUserByEmail,
  hashPassword,
  passwordProblem,
  normalizeEmail,
  destroyAllSessionsForUser,
} from './auth.js';
import { query, logEvent } from './db.js';

/**
 * Create the first admin account from environment variables, for hosts where
 * running a one-off command needs a paid plan.
 *
 *   SEED_ADMIN_EMAIL=gm@fishshop.com
 *   SEED_ADMIN_NAME=Gina Marsh
 *   SEED_ADMIN_PASSWORD=…
 *
 * It only ever fires when the database holds no accounts at all, so it can't
 * overwrite anyone or quietly re-create a deleted account. Once you've signed
 * in, remove SEED_ADMIN_PASSWORD — there's no reason to leave a password
 * sitting in a dashboard.
 */
/**
 * Break-glass password reset, for an admin locked out of a host with no free
 * shell. Set SEED_ADMIN_RESET=true alongside SEED_ADMIN_EMAIL and
 * SEED_ADMIN_PASSWORD, and that account's password becomes the one you set.
 *
 * This is no weaker than the deployment already is: anyone who can edit these
 * variables can already point the app at a different database entirely. It is
 * deliberately loud, and you should clear the variables once you are back in.
 */
async function resetAdminPassword(email, password, name) {
  const user = await findUserByEmail(email);
  if (!user) {
    console.warn(`  SEED_ADMIN_RESET is set but no account exists for ${email}.`);
    console.warn('  Leave SEED_ADMIN_RESET off to have that account created instead.');
    return null;
  }

  await query(
    `UPDATE users
     SET password_hash = $1, role = 'admin', active = TRUE, must_change_password = FALSE
     WHERE id = $2`,
    [hashPassword(password), user.id]
  );
  await destroyAllSessionsForUser(user.id);
  await logEvent({ userId: user.id, type: 'password_reset_via_environment' });

  console.warn(`  RESET the password for ${user.name} <${user.email}> and restored admin access.`);
  console.warn('  Every session for that account was signed out. Sign in with the new password,');
  console.warn('  then REMOVE SEED_ADMIN_RESET and SEED_ADMIN_PASSWORD from your environment.');
  return user;
}

export async function maybeSeedFirstAdmin() {
  const email = normalizeEmail(process.env.SEED_ADMIN_EMAIL);
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  const name = (process.env.SEED_ADMIN_NAME || '').trim() || 'Administrator';

  if (!email && !password) return null;

  if (!email || !password) {
    console.warn('  SEED_ADMIN_* is incomplete — set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.');
    return null;
  }

  const wantsReset = ['1', 'true', 'yes', 'on'].includes(String(process.env.SEED_ADMIN_RESET || '').toLowerCase());

  if (!email.includes('@')) {
    console.error(`  SEED_ADMIN_EMAIL ("${email}") is not a valid email address. No account created.`);
    return null;
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.error(`  SEED_ADMIN_PASSWORD rejected: ${problem} Nothing changed.`);
    return null;
  }

  if (wantsReset) return resetAdminPassword(email, password, name);

  if ((await countUsers()) > 0) {
    console.log('  SEED_ADMIN_* is set but accounts already exist — skipping.');
    console.log('  You can safely remove those variables, or set SEED_ADMIN_RESET=true to');
    console.log('  reset that account\'s password if you are locked out.');
    return null;
  }

  const user = await createUser({ email, name, password, role: 'admin' });
  console.log(`  Created the first admin account: ${user.name} <${user.email}>`);
  console.log('  Sign in with it, then REMOVE SEED_ADMIN_PASSWORD from your environment.');
  return user;
}
