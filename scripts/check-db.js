/**
 * Check that DATABASE_URL actually works, and explain it in plain terms when
 * it doesn't. Run this before deploying, or in your host's shell when the app
 * won't start:
 *
 *   npm run check-db
 *   DATABASE_URL='postgresql://…' npm run check-db
 */
import { config } from '../src/config.js';

if (!config.databaseUrl) {
  console.log('DATABASE_URL is not set.');
  console.log('That is fine for local development — the app uses its built-in database.');
  console.log('In production, set DATABASE_URL to your Postgres connection string.');
  process.exit(0);
}

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Show the host without ever printing the password. */
function describe(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, '') || '(default)',
      user: decodeURIComponent(parsed.username) || '(none)',
      hasPassword: Boolean(parsed.password),
      // URL() percent-encodes what it parses, so decode before inspecting.
      rawPassword: safeDecode(parsed.password),
    };
  } catch {
    return null;
  }
}

const info = describe(config.databaseUrl);

if (!info) {
  console.error('DATABASE_URL is not a valid URL.');
  console.error('It should look like: postgresql://user:password@host:5432/dbname');
  process.exit(1);
}

console.log(`Host:      ${info.host}`);
console.log(`Port:      ${info.port}`);
console.log(`Database:  ${info.database}`);
console.log(`User:      ${info.user}`);
console.log(`Password:  ${info.hasPassword ? 'set' : 'MISSING'}`);
console.log(`TLS:       ${config.databaseSsl ? 'on' : 'off'}\n`);

// A password containing an unencoded "@" splits the URL early, so the parser
// reads part of the password as the hostname. Without this the user gets a
// baffling "hostname does not resolve" for a perfectly real host.
if ((config.databaseUrl.match(/@/g) || []).length > 1) {
  console.error('There is more than one "@" in DATABASE_URL.');
  console.error('If your password contains @, percent-encode it as %40 — otherwise the');
  console.error(`URL splits in the wrong place and the host reads as "${info.host}".`);
  console.error('Other characters needing the same treatment: : → %3A, / → %2F, # → %23');
  process.exit(1);
}

if (/\[YOUR-PASSWORD\]|\[your-password\]/i.test(config.databaseUrl)) {
  console.error('The password is still the placeholder your provider printed.');
  console.error('Replace [YOUR-PASSWORD] — brackets included — with your real password.');
  process.exit(1);
}

// Brackets are the placeholder's markers, not part of anyone's password.
if (/^\[.*\]$/.test(info.rawPassword || '')) {
  console.error('Your password is still wrapped in square brackets.');
  console.error('The [ ] only marked where to type — remove them:');
  console.error('  :[mySecret123]@   should be   :mySecret123@');
  process.exit(1);
}

const { default: pg } = await import('pg');
const client = new pg.Client({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: config.databaseSslStrict } : false,
  connectionTimeoutMillis: 15_000,
});

try {
  await client.connect();
  const { rows } = await client.query('SELECT version()');
  console.log('Connected.');
  console.log(`  ${rows[0].version.split(',')[0]}`);

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
     ORDER BY table_name`
  );
  if (tables.rows.length) {
    console.log(`  Tables: ${tables.rows.map((r) => r.table_name).join(', ')}`);
  } else {
    console.log('  No tables yet — the app creates them the first time it starts.');
  }

  const canWrite = await client.query("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok");
  if (!canWrite.rows[0].ok) {
    console.warn('\nWarning: this user cannot create tables in this database.');
    process.exitCode = 1;
  } else {
    console.log('\nThis connection string is good. Put it in DATABASE_URL.');
  }
} catch (error) {
  console.error('Could not connect.\n');
  const message = String(error.message);

  if (/ENETUNREACH|EHOSTUNREACH/.test(message)) {
    console.error('The host could not be reached over the network.');
    console.error('On Supabase this usually means you copied the "Direct connection"');
    console.error('string, which is IPv6-only. Use the Session pooler string instead.');
  } else if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    console.error(`The hostname "${info.host}" does not resolve. Check it for typos.`);
  } else if (/ECONNREFUSED/.test(message)) {
    console.error('Nothing is listening there. Check the host and port.');
  } else if (/password|authentication|SASL/i.test(message)) {
    console.error('The server rejected the username or password.');
    console.error('If your password contains @ : / or #, percent-encode it (@ becomes %40),');
    console.error('or reset the database password in your provider\'s dashboard.');
  } else if (/self.signed|certificate|SSL|TLS/i.test(message)) {
    console.error('The TLS handshake failed. Confirm your provider requires SSL;');
    console.error('set DATABASE_SSL=false only for a local server.');
  } else if (/timeout/i.test(message)) {
    console.error('The connection timed out — often a firewall, or the wrong port.');
  } else if (/database .* does not exist/i.test(message)) {
    console.error(`The database "${info.database}" does not exist on that server.`);
  }

  console.error(`\nUnderlying error: ${message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
