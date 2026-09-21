/**
 * Proves a recap really leaves the building: a throwaway SMTP server stands in
 * for SendGrid/Gmail, and we assert on the message it actually receives.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const received = [];

/** The smallest SMTP server that will satisfy a real client. */
function startFakeSmtp() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let message = '';
      const envelope = { to: [], from: '' };

      socket.write('220 fake.smtp ESMTP ready\r\n');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        if (inData) {
          const terminator = buffer.indexOf('\r\n.\r\n');
          if (terminator === -1) return;
          message += buffer.slice(0, terminator);
          buffer = '';
          inData = false;
          received.push({ ...envelope, message });
          message = '';
          socket.write('250 2.0.0 Ok: queued\r\n');
          return;
        }

        let newline;
        while ((newline = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          const command = line.slice(0, 4).toUpperCase();

          if (command === 'EHLO' || command === 'HELO') {
            socket.write('250-fake.smtp\r\n250 8BITMIME\r\n');
          } else if (command === 'MAIL') {
            envelope.from = line;
            socket.write('250 2.1.0 Ok\r\n');
          } else if (command === 'RCPT') {
            envelope.to.push(line.replace(/.*<([^>]+)>.*/, '$1'));
            socket.write('250 2.1.5 Ok\r\n');
          } else if (command === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            if (buffer) { socket.emit('data', Buffer.alloc(0)); }
            break;
          } else if (command === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }
        }
      });

      socket.on('error', () => { /* client hung up */ });
    });

    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fscl-mail-'));
const smtp = await startFakeSmtp();

process.env.DB_PATH = path.join(tmpDir, 'mail.db');
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.address().port);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = '';
process.env.MAIL_FROM = 'Captains Log <no-reply@fishshop.test>';
process.env.APP_URL = 'https://log.fishshop.test';
process.env.NODE_ENV = 'test';

const { app } = await import('../src/server.js');
const { createUser } = await import('../src/auth.js');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  createUser({ email: 'mgr@test.com', name: 'Manny Manager', password: 'password123', role: 'manager' });
});

after(() => {
  server?.close();
  smtp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Undo RFC 2047 encoded-words so a header can be read as text. The subject
 * carries a "·", so real mailers encode it — decoding keeps the assertion
 * about the subject itself rather than its transfer encoding.
 */
function decodeHeader(raw) {
  return raw
    .replace(/\?=\r\n\s+=\?UTF-8\?Q\?/gi, '')            // join folded encoded-words
    .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, text) => {
      const bytes = text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      // The quoted-printable bytes are UTF-8; reassemble them as such.
      return Buffer.from(bytes, 'latin1').toString('utf8');
    });
}

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
    for (const entry of res.headers.getSetCookie?.() || []) {
      const [pair] = entry.split(';');
      if (pair.startsWith('fscl_session=')) cookie = pair;
    }
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: text }; }
  };
}

test('closing a shift emails the recap to the chosen recipients', async () => {
  const call = client();
  await call('/api/auth/login', { method: 'POST', body: { email: 'mgr@test.com', password: 'password123' } });

  const { data: opened } = await call('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'PM', businessDate: '2026-04-01' },
  });
  const id = opened.shift.id;

  await call(`/api/shifts/${id}/items/open-doors/state`, { method: 'POST', body: { state: 'done' } });
  await call(`/api/shifts/${id}/items/postpeak-till-audit/flag`, { method: 'POST', body: { flagged: true } });
  await call(`/api/shifts/${id}/items/postpeak-till-audit/note`, {
    method: 'POST',
    body: { note: 'Drawer 3 short $22 — Marcus counting again at 10.' },
  });

  const closed = await call(`/api/shifts/${id}/close`, {
    method: 'POST',
    body: {
      summary: 'Net sales $14,220. Labor 24.1%.',
      sendRecap: true,
      recipients: 'owner@fishshop.test, gm@fishshop.test',
    },
  });

  assert.equal(closed.status, 200);
  assert.equal(closed.data.shift.status, 'closed');
  assert.equal(closed.data.email.sent, true);
  assert.deepEqual(closed.data.email.recipients, ['owner@fishshop.test', 'gm@fishshop.test']);
  assert.ok(closed.data.shift.recapSentAt, 'the shift should record when the recap went out');

  // And the SMTP server actually got it.
  assert.equal(received.length, 1, 'expected exactly one message on the wire');
  const mail = received[0];
  assert.deepEqual(mail.to.sort(), ['gm@fishshop.test', 'owner@fishshop.test']);
  assert.match(mail.from, /no-reply@fishshop\.test/);
  assert.match(decodeHeader(mail.message), /Subject: Point Loma · PM shift recap · Wednesday, April 1, 2026/);
  assert.match(mail.message, /multipart\/alternative/, 'should carry both a text and an HTML part');

  // Quoted-printable encodes the body, so decode the soft line breaks first.
  const body = mail.message.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  assert.match(body, /Drawer 3 short \$22/);
  assert.match(body, /Net sales \$14,220/);
  assert.match(body, /NEEDS ATTENTION/);
  assert.match(body, /https:\/\/log\.fishshop\.test\/shift\//, 'recap should link back to the shift');

  // The send is recorded in the running log for the next manager to see.
  const { data: detail } = await call(`/api/shifts/${id}`);
  assert.ok(detail.events.some((e) => e.type === 'recap_sent' && e.detail.includes('owner@fishshop.test')));
});

test('a recap can be re-sent to different recipients later', async () => {
  const call = client();
  await call('/api/auth/login', { method: 'POST', body: { email: 'mgr@test.com', password: 'password123' } });

  const { data: opened } = await call('/api/shifts', {
    method: 'POST',
    body: { location: 'Pacific Beach', shiftType: 'AM', businessDate: '2026-04-02' },
  });

  const before = received.length;
  const res = await call(`/api/shifts/${opened.shift.id}/recap/email`, {
    method: 'POST',
    body: { recipients: 'district@fishshop.test' },
  });

  assert.equal(res.status, 200);
  assert.equal(received.length, before + 1);
  assert.deepEqual(received.at(-1).to, ['district@fishshop.test']);
});

test('invalid addresses are rejected before anything is sent', async () => {
  const call = client();
  await call('/api/auth/login', { method: 'POST', body: { email: 'mgr@test.com', password: 'password123' } });

  const { data: opened } = await call('/api/shifts', {
    method: 'POST',
    body: { location: 'Point Loma', shiftType: 'AM', businessDate: '2026-04-03' },
  });

  const before = received.length;
  const res = await call(`/api/shifts/${opened.shift.id}/recap/email`, {
    method: 'POST',
    body: { recipients: 'not-an-address, also bad' },
  });

  assert.equal(res.status, 400);
  assert.equal(received.length, before, 'nothing should have been sent');
});
