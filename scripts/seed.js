/**
 * First-run setup: creates the admin account you sign in with.
 *
 *   SEED_ADMIN_EMAIL=gm@fishshop.com \
 *   SEED_ADMIN_NAME="General Manager" \
 *   SEED_ADMIN_PASSWORD='something-long' npm run seed
 *
 * Safe to re-run: an existing account is left alone.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createUser, findUserByEmail, passwordProblem, normalizeEmail, countUsers } from '../src/auth.js';
import { initDb, closeDb, driver } from '../src/db.js';

async function ask(question, fallback = '') {
  if (!stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer || fallback;
}

try {
  await initDb();
  console.log(`Connected to the ${driver === 'postgres' ? 'Postgres database' : 'local database'}.`);

  const email = normalizeEmail(process.env.SEED_ADMIN_EMAIL || (await ask('Admin email: ')));
  const name = process.env.SEED_ADMIN_NAME || (await ask('Admin name: ', 'General Manager'));
  const password = process.env.SEED_ADMIN_PASSWORD || (await ask('Admin password (min 8 chars): '));

  if (!email.includes('@')) {
    console.error('A valid email is required. Set SEED_ADMIN_EMAIL or answer the prompt.');
    process.exit(1);
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  if (await findUserByEmail(email)) {
    console.log(`${email} already exists — nothing to do.`);
  } else {
    const user = await createUser({ email, name, password, role: 'admin' });
    console.log(`Created admin: ${user.name} <${user.email}>`);
    console.log(`Users in database: ${await countUsers()}`);
    console.log('Sign in, then add your managers under Team & settings.');
  }
} catch (error) {
  console.error('Seeding failed:', error.message);
  if (/ECONNREFUSED|ENOTFOUND|password|SSL/i.test(error.message)) {
    console.error('Check DATABASE_URL — the script could not reach your Postgres database.');
  }
  process.exitCode = 1;
} finally {
  await closeDb();
}
