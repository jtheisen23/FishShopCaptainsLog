/** Wrap an async handler so rejections reach the express error handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

/** Parse `Cookie` into an object. Saves a dependency for the one cookie we set. */
export function cookieParser(req, _res, next) {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      if (!key) continue;
      try {
        req.cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        req.cookies[key] = part.slice(eq + 1).trim();
      }
    }
  }
  next();
}

/**
 * CSRF defence. The session cookie is SameSite=Lax, so a cross-site form POST
 * never carries it; this closes the remaining gap by refusing any state-changing
 * request whose Origin isn't us.
 */
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // Non-browser clients (curl, scripts) send no Origin.

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'Bad origin.' });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: 'Cross-origin request refused.' });
  }
  next();
}
