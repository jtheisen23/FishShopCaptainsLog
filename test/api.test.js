import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the app at a throwaway database before anything imports config/db.
// With no DATABASE_URL set, the app runs its embedded Postgres against this
// folder — same SQL as production, nothing to install.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscl-test-'));
// Honour an externally supplied DATABASE_URL so the same suite can be run
// against a real Postgres server; otherwise fall back to the embedded one.
process.env.PGLITE_DIR = path.join(tmpDir, 'pgdata');
process.env.TIMEZONE = 'America/Los_Angeles';
process.env.NODE_ENV = 'test';

const { app } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/db.js');
const { createUser } = await import('../src/auth.js');
const { businessDateFor } = await import('../src/shifts.js');

let server;
let base;

before(async () => {
  await initDb();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await createUser({ email: 'gm@test.com', name: 'Gina GM', password: 'password123', role: 'admin' });
  await createUser({ email: 'mgr@test.com', name: 'Manny Manager', password: 'password123', role: 'manager' });
  await createUser({ email: 'staff@test.com', name: 'Sam Staff', password: 'password123', role: 'staff' });
});

after(async () => {
  server?.close();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal fetch wrapper that carries a session cookie between calls. */
function client() {
  let cookie = '';
  return async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const entry of setCookie) {
      const [pair] = entry.split(';');
      if (pair.startsWith('fscl_session=')) cookie = pair;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

async function signedIn(email, password = 'password123') {
  const call = client();
  const res = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.data)}`);
  return call;
}

test('health endpoint reports the database is reachable', async () => {
  const call = client();
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.users >= 3);
  assert.equal(data.database, process.env.DATABASE_URL ? 'postgres' : 'pglite');
});

test('anonymous callers get no data, and bootstrap reports no user', async () => {
  const call = client();

  // Bootstrap answers anonymously so the login page loads without an error.
  const boot = await call('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.data.user, null);
  assert.equal(boot.data.locations, undefined, 'anonymous bootstrap must not leak shop config');

  // Everything that carries real data stays shut.
  assert.equal((await call('/api/shifts')).status, 401);
  assert.equal((await call('/api/shifts/1')).status, 401);
  assert.equal((await call('/api/shifts/1/recap.txt')).status, 401);
  assert.equal((await call('/api/admin/users')).status, 401);
  assert.equal(
    (await call('/api/shifts/1/items/open-doors/state', { method: 'POST', body: { state: 'done' } })).status,
    401
  );
});

test('a wrong password is rejected and reveals nothing', async () => {
  const call = client();
  const wrongPassword = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'gm@test.com', password: 'nope' },
  });
  const noSuchUser = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'ghost@test.com', password: 'nope' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(wrongPassword.data.error, noSuchUser.data.error);
});

test('bootstrap describes the shop, and hides recap recipients from staff', async () => {
  const gm = await signedIn('gm@test.com');
  const { data } = await gm('/api/bootstrap');
  assert.equal(data.user.name, 'Gina GM');
  assert.equal(data.template.totalItems, 33);
  assert.equal(data.template.sections.length, 7);
  assert.ok(data.locations.includes('Point Loma'));
  assert.equal(data.today, businessDateFor());

  const staff = await signedIn('staff@test.com');
  const staffBoot = await staff('/api/bootstrap');
  assert.deepEqual(staffBoot.data.defaultRecipients, []);
});

test('opening the same slot twice returns the same shift', async () => {
  const mgr = await signedIn('mgr@test.com');
  const body = { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-03-01' };
  const first = await mgr('/api/shifts', { method: 'POST', body });
  const second = await mgr('/api/shifts', { method: 'POST', body });
  assert.equal(first.status, 200);
  assert.equal(first.data.shift.id, second.data.shift.id);
  assert.equal(first.data.progress.done, 0);
  assert.equal(first.data.progress.total, 33);
});

test('an invalid location or shift type is refused', async () => {
  const mgr = await signedIn('mgr@test.com');
  const badLocation = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Atlantis', shiftType: 'AM', businessDate: '2026-03-01' },
  });
  const badDate = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'AM', businessDate: 'tomorrow' },
  });
  assert.equal(badLocation.status, 400);
  assert.equal(badDate.status, 400);
});

test('checking an item stamps who and when, and lands in the running log', async () => {
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await staff('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'PM', businessDate: '2026-03-02' },
  });

  const { data } = await staff(`/api/shifts/${shift.shift.id}/items/open-doors/state`, {
    method: 'POST',
    body: { state: 'done' },
  });

  const item = data.sections.flatMap((s) => s.items).find((i) => i.key === 'open-doors');
  assert.equal(item.state, 'done');
  assert.equal(item.checkedBy, 'Sam Staff');
  assert.ok(item.checkedAt, 'expected a completion timestamp');
  assert.match(item.checkedAtLabel, /\d{1,2}:\d{2}/);
  assert.equal(data.progress.done, 1);

  assert.ok(data.events.some((e) => e.type === 'item_done' && e.itemKey === 'open-doors'));
});

test('unchecking clears the stamp', async () => {
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await staff('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'PM', businessDate: '2026-03-02' },
  });
  const id = shift.shift.id;

  await staff(`/api/shifts/${id}/items/open-patio/state`, { method: 'POST', body: { state: 'done' } });
  const { data } = await staff(`/api/shifts/${id}/items/open-patio/state`, {
    method: 'POST',
    body: { state: 'open' },
  });

  const item = data.sections.flatMap((s) => s.items).find((i) => i.key === 'open-patio');
  assert.equal(item.state, 'open');
  assert.equal(item.checkedBy, null);
  assert.equal(item.checkedAt, null);
});

test('notes and flags attach to an item and survive a reload', async () => {
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await staff('/api/shifts', {
    method: 'POST',
    body: { location: 'Pacific Beach', shiftType: 'AM', businessDate: '2026-03-03' },
  });
  const id = shift.shift.id;

  await staff(`/api/shifts/${id}/items/open-line-check/note`, {
    method: 'POST',
    body: { note: 'Walk-in reading 41F, called refrigeration.' },
  });
  await staff(`/api/shifts/${id}/items/open-line-check/flag`, { method: 'POST', body: { flagged: true } });

  const { data } = await staff(`/api/shifts/${id}`);
  const item = data.sections.flatMap((s) => s.items).find((i) => i.key === 'open-line-check');
  assert.equal(item.note, 'Walk-in reading 41F, called refrigeration.');
  assert.equal(item.flagged, true);
  assert.equal(data.progress.flagged, 1);
});

test('an unknown checklist item is rejected', async () => {
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await staff('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-03-04' },
  });
  const res = await staff(`/api/shifts/${shift.shift.id}/items/not-a-real-item/state`, {
    method: 'POST',
    body: { state: 'done' },
  });
  assert.equal(res.status, 400);
});

test('staff cannot close a shift; a manager can', async () => {
  const staff = await signedIn('staff@test.com');
  const mgr = await signedIn('mgr@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-03-05' },
  });
  const id = shift.shift.id;

  const refused = await staff(`/api/shifts/${id}/close`, { method: 'POST', body: { summary: 'nope' } });
  assert.equal(refused.status, 403);

  const closed = await mgr(`/api/shifts/${id}/close`, { method: 'POST', body: { summary: 'Solid night.' } });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.shift.status, 'closed');
  assert.equal(closed.data.shift.closedBy, 'Manny Manager');
  assert.equal(closed.data.shift.summary, 'Solid night.');
});

test('a closed shift is read-only until a manager reopens it', async () => {
  const mgr = await signedIn('mgr@test.com');
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'PM', businessDate: '2026-03-06' },
  });
  const id = shift.shift.id;

  await mgr(`/api/shifts/${id}/close`, { method: 'POST', body: {} });

  const blocked = await staff(`/api/shifts/${id}/items/open-doors/state`, {
    method: 'POST',
    body: { state: 'done' },
  });
  assert.equal(blocked.status, 409);

  const reopened = await mgr(`/api/shifts/${id}/reopen`, { method: 'POST', body: {} });
  assert.equal(reopened.data.shift.status, 'open');

  const allowed = await staff(`/api/shifts/${id}/items/open-doors/state`, {
    method: 'POST',
    body: { state: 'done' },
  });
  assert.equal(allowed.status, 200);
});

test('the recap lists what was missed, flagged and noted', async () => {
  const mgr = await signedIn('mgr@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Pacific Beach', shiftType: 'PM', businessDate: '2026-03-07' },
  });
  const id = shift.shift.id;

  await mgr(`/api/shifts/${id}/items/admin-safe-count/state`, { method: 'POST', body: { state: 'done' } });
  await mgr(`/api/shifts/${id}/items/admin-bank-run/state`, { method: 'POST', body: { state: 'na' } });
  await mgr(`/api/shifts/${id}/items/postpeak-till-audit/flag`, { method: 'POST', body: { flagged: true } });
  await mgr(`/api/shifts/${id}/items/postpeak-till-audit/note`, {
    method: 'POST',
    body: { note: 'Drawer 3 short $22.' },
  });
  await mgr(`/api/shifts/${id}/log`, { method: 'POST', body: { text: 'Lost power for 6 minutes at 7pm.' } });

  const { data: text } = await mgr(`/api/shifts/${id}/recap.txt`);
  assert.match(text, /Pacific Beach · PM shift recap/);
  assert.match(text, /NEEDS ATTENTION \(1\)/);
  assert.match(text, /Drawer 3 short \$22\./);
  assert.match(text, /MARKED N\/A \(1\)/);
  assert.match(text, /NOT COMPLETED \(31\)/);
  assert.match(text, /Lost power for 6 minutes at 7pm\./);

  const { status, data: html } = await mgr(`/api/shifts/${id}/recap.html`);
  assert.equal(status, 200);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Drawer 3 short \$22\./);
});

test('recap HTML escapes user-supplied text', async () => {
  const mgr = await signedIn('mgr@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-03-08' },
  });
  const id = shift.shift.id;

  await mgr(`/api/shifts/${id}/items/open-doors/note`, {
    method: 'POST',
    body: { note: '<script>alert(1)</script>' },
  });

  const { data: html } = await mgr(`/api/shifts/${id}/recap.html`);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag leaked into the recap');
  assert.match(html, /&lt;script&gt;/);
});

test('emailing a recap fails cleanly when SMTP is not configured', async () => {
  const mgr = await signedIn('mgr@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-03-09' },
  });
  const res = await mgr(`/api/shifts/${shift.shift.id}/recap/email`, {
    method: 'POST',
    body: { recipients: 'someone@example.com' },
  });
  assert.equal(res.status, 503);
  assert.match(res.data.error, /not configured/i);
});

test('a recap with no recipients is refused before any send is attempted', async () => {
  const mgr = await signedIn('mgr@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'PM', businessDate: '2026-03-10' },
  });
  const res = await mgr(`/api/shifts/${shift.shift.id}/recap/email`, {
    method: 'POST',
    body: { recipients: '' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /No recap recipients/i);
});

test('only admins reach the admin routes', async () => {
  const mgr = await signedIn('mgr@test.com');
  const gm = await signedIn('gm@test.com');
  assert.equal((await mgr('/api/admin/users')).status, 403);
  assert.equal((await gm('/api/admin/users')).status, 200);
});

test('an admin can add a user who must then set their own password', async () => {
  const gm = await signedIn('gm@test.com');
  const created = await gm('/api/admin/users', {
    method: 'POST',
    body: { email: 'New.Hire@Test.com', name: 'Nadia Newhire', role: 'staff', password: 'temp12345' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.email, 'new.hire@test.com', 'email should be normalised to lowercase');
  assert.equal(created.data.user.mustChangePassword, true);

  const duplicate = await gm('/api/admin/users', {
    method: 'POST',
    body: { email: 'new.hire@test.com', name: 'Dup', role: 'staff', password: 'temp12345' },
  });
  assert.equal(duplicate.status, 409);

  const hire = await signedIn('new.hire@test.com', 'temp12345');
  const boot = await hire('/api/bootstrap');
  assert.equal(boot.data.user.mustChangePassword, true);
});

test('an admin cannot lock themselves out', async () => {
  const gm = await signedIn('gm@test.com');
  const { data: me } = await gm('/api/bootstrap');
  const demote = await gm(`/api/admin/users/${me.user.id}`, { method: 'PATCH', body: { role: 'staff' } });
  const deactivate = await gm(`/api/admin/users/${me.user.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal(demote.status, 400);
  assert.equal(deactivate.status, 400);
});

test('settings round-trip, and bad recipient addresses are caught', async () => {
  const gm = await signedIn('gm@test.com');
  const saved = await gm('/api/admin/settings', {
    method: 'PUT',
    body: {
      locations: ['Point Loma', 'Pacific Beach', 'La Jolla'],
      shiftTypes: ['AM', 'PM'],
      recapRecipients: ['owner@test.com', 'gm@test.com'],
    },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.locations, ['Point Loma', 'Pacific Beach', 'La Jolla']);

  const bad = await gm('/api/admin/settings', { method: 'PUT', body: { recapRecipients: ['not-an-email'] } });
  assert.equal(bad.status, 400);

  const boot = await gm('/api/bootstrap');
  assert.deepEqual(boot.data.defaultRecipients, ['owner@test.com', 'gm@test.com']);
});

test('deactivating a user kills their existing session', async () => {
  const gm = await signedIn('gm@test.com');
  const { data: created } = await gm('/api/admin/users', {
    method: 'POST',
    body: { email: 'temp@test.com', name: 'Temp Worker', role: 'staff', password: 'temp12345' },
  });

  const temp = await signedIn('temp@test.com', 'temp12345');
  assert.equal((await temp('/api/bootstrap')).status, 200);

  await gm(`/api/admin/users/${created.user.id}`, { method: 'PATCH', body: { active: false } });
  const afterDeactivation = await temp('/api/bootstrap');
  assert.equal(afterDeactivation.data.user, null, 'a deactivated user must not stay signed in');
  assert.equal((await temp('/api/shifts')).status, 401);
});

test('signing out invalidates the session', async () => {
  const mgr = await signedIn('mgr@test.com');
  assert.ok((await mgr('/api/bootstrap')).data.user);
  await mgr('/api/auth/logout', { method: 'POST' });
  assert.equal((await mgr('/api/bootstrap')).data.user, null);
  assert.equal((await mgr('/api/shifts')).status, 401);
});

test('history filters by location and date range', async () => {
  const gm = await signedIn('gm@test.com');
  const { data } = await gm('/api/shifts?location=Pacific%20Beach&from=2026-03-01&to=2026-03-31');
  assert.ok(data.shifts.length >= 2);
  assert.ok(data.shifts.every((s) => s.location === 'Pacific Beach'));
  assert.ok(data.shifts.every((s) => s.businessDate >= '2026-03-01' && s.businessDate <= '2026-03-31'));
});

test('a cross-origin write is refused', async () => {
  const mgr = await signedIn('mgr@test.com');
  // signedIn() gives us a valid cookie; the Origin header is the only difference.
  const res = await fetch(`${base}/api/shifts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ location: 'Point Loma', shiftType: 'AM', businessDate: '2026-03-11' }),
  });
  assert.equal(res.status, 403);
});

test('two devices opening the same shift at once get one shift, not two', async () => {
  const opener = await signedIn('mgr@test.com');
  const closer = await signedIn('gm@test.com');
  const body = { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-05-01' };

  // The opener's tablet and the closer's phone, racing on the same slot.
  const [first, second] = await Promise.all([
    opener('/api/shifts', { method: 'POST', body }),
    closer('/api/shifts', { method: 'POST', body }),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.data.shift.id, second.data.shift.id, 'a duplicate shift was created');

  const { data } = await opener('/api/shifts?location=Point%20Loma&from=2026-05-01&to=2026-05-01');
  assert.equal(data.shifts.length, 1);
});

test('simultaneous checks from different phones all land', async () => {
  const mgr = await signedIn('mgr@test.com');
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Pacific Beach', shiftType: 'PM', businessDate: '2026-05-02' },
  });
  const id = shift.shift.id;

  const keys = ['open-doors', 'open-patio', 'open-online-ordering', 'open-clock-schedule'];
  const results = await Promise.all(
    keys.map((key, index) =>
      (index % 2 ? staff : mgr)(`/api/shifts/${id}/items/${key}/state`, {
        method: 'POST',
        body: { state: 'done' },
      })
    )
  );

  assert.ok(results.every((r) => r.status === 200), 'a concurrent check was rejected');

  const { data } = await mgr(`/api/shifts/${id}`);
  const done = data.sections.flatMap((s) => s.items).filter((i) => i.state === 'done');
  assert.equal(done.length, keys.length);
  assert.equal(data.progress.done, keys.length);
});

test('two people tapping the same item at once is not an error', async () => {
  const mgr = await signedIn('mgr@test.com');
  const staff = await signedIn('staff@test.com');
  const { data: shift } = await mgr('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'PM', businessDate: '2026-05-03' },
  });
  const id = shift.shift.id;

  const results = await Promise.all([
    mgr(`/api/shifts/${id}/items/peak-log-sales/state`, { method: 'POST', body: { state: 'done' } }),
    staff(`/api/shifts/${id}/items/peak-log-sales/state`, { method: 'POST', body: { state: 'done' } }),
  ]);

  assert.ok(results.every((r) => r.status === 200), `expected both to succeed, got ${results.map((r) => r.status)}`);

  const { data } = await mgr(`/api/shifts/${id}`);
  const item = data.sections.flatMap((s) => s.items).find((i) => i.key === 'peak-log-sales');
  assert.equal(item.state, 'done');
  assert.ok(item.checkedBy, 'the item should still carry a stamp');
  assert.equal(data.progress.done, 1, 'the item should be counted once');
});
