import path from 'node:path';
import express from 'express';
import { config, ROOT, smtpConfigured } from './config.js';
import { initDb, closeDb, driver } from './db.js';
import { attachUser, purgeExpiredSessions, countUsers } from './auth.js';
import { cookieParser, sameOriginOnly } from './routes/helpers.js';
import { authRouter } from './routes/auth.js';
import { shiftsRouter } from './routes/shifts.js';
import { adminRouter } from './routes/admin.js';

export const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '128kb' }));
app.use(cookieParser);
app.use(sameOriginOnly);
app.use(attachUser);

app.get('/api/health', async (_req, res) => {
  try {
    res.json({
      ok: true,
      users: await countUsers(),
      database: driver,
      emailEnabled: smtpConfigured,
      timezone: config.timezone,
    });
  } catch (error) {
    // Health must report a database it can't reach, not pretend to be fine.
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api', shiftsRouter);
app.use('/api/admin', adminRouter);

app.use(
  express.static(path.join(ROOT, 'public'), {
    index: 'index.html',
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  })
);

// Client-side routes (/shift/12, /history, ...) all render the same shell.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((error, req, res, _next) => {
  // An error we raised on purpose carries a status; anything else is a bug and
  // gets a generic message so internals never reach the client.
  const deliberate = Number.isInteger(error.status);
  const status = deliberate ? error.status : 500;
  if (!deliberate) console.error(`[${req.method} ${req.originalUrl}]`, error);
  res.status(status).json({ error: deliberate ? error.message : 'Something went wrong on the server.' });
});

export async function start() {
  await initDb();

  await purgeExpiredSessions();
  setInterval(() => {
    purgeExpiredSessions().catch((error) => console.error('[session purge]', error.message));
  }, 6 * 60 * 60 * 1000).unref();

  const userCount = await countUsers();

  const server = app.listen(config.port, () => {
    console.log(`${config.brandName} listening on http://localhost:${config.port}`);
    console.log(
      `  database: ${driver}   timezone: ${config.timezone}   email: ${smtpConfigured ? 'configured' : 'NOT configured'}`
    );
    if (userCount === 0) console.log('  No users yet — run `npm run seed` to create the first admin.');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(async () => {
        await closeDb();
        process.exit(0);
      });
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error) => {
    console.error('Failed to start:', error.message);
    // Only add the generic hint when the error hasn't already named the cause.
    if (!/DATABASE_URL/.test(error.message)) {
      console.error('Check DATABASE_URL — the app could not reach your Postgres database.');
      console.error('Run `npm run check-db` to test your connection string.');
    }
    process.exit(1);
  });
}
