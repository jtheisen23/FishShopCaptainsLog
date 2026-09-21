import path from 'node:path';
import express from 'express';
import { config, ROOT, smtpConfigured } from './config.js';
import { db, logEvent } from './db.js';
import { attachUser, purgeExpiredSessions } from './auth.js';
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

app.get('/api/health', (_req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ ok: true, users, emailEnabled: smtpConfigured, timezone: config.timezone });
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

function start() {
  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

  const server = app.listen(config.port, () => {
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    console.log(`${config.brandName} listening on http://localhost:${config.port}`);
    console.log(`  timezone: ${config.timezone}   email: ${smtpConfigured ? 'configured' : 'NOT configured'}`);
    if (userCount === 0) console.log('  No users yet — run `npm run seed` to create the first admin.');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* already closed */
        }
        process.exit(0);
      });
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export { start, logEvent };
