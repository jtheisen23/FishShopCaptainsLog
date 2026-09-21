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
import { createUser, findUserByEmail, passwordProblem, normalizeEmail } from '../src/auth.js';
import { db } from '../src/db.js';

async function ask(question, fallback = '') {
  if (!stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer || fallback;
}

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

if (findUserByEmail(email)) {
  console.log(`${email} already exists — nothing to do.`);
  process.exit(0);
}

const user = createUser({ email, name, password, role: 'admin' });
const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

console.log(`Created admin: ${user.name} <${user.email}>`);
console.log(`Users in database: ${total}`);
console.log('Start the app with `npm start`, then sign in and add your managers under Settings.');
