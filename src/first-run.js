import { countUsers, createUser, passwordProblem, normalizeEmail } from './auth.js';

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
export async function maybeSeedFirstAdmin() {
  const email = normalizeEmail(process.env.SEED_ADMIN_EMAIL);
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  const name = (process.env.SEED_ADMIN_NAME || '').trim() || 'Administrator';

  if (!email && !password) return null;

  if (!email || !password) {
    console.warn('  SEED_ADMIN_* is incomplete — set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.');
    return null;
  }

  if ((await countUsers()) > 0) {
    console.log('  SEED_ADMIN_* is set but accounts already exist — skipping.');
    console.log('  You can safely remove those variables now.');
    return null;
  }

  if (!email.includes('@')) {
    console.error(`  SEED_ADMIN_EMAIL ("${email}") is not a valid email address. No account created.`);
    return null;
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.error(`  SEED_ADMIN_PASSWORD rejected: ${problem} No account created.`);
    return null;
  }

  const user = await createUser({ email, name, password, role: 'admin' });
  console.log(`  Created the first admin account: ${user.name} <${user.email}>`);
  console.log('  Sign in with it, then REMOVE SEED_ADMIN_PASSWORD from your environment.');
  return user;
}
