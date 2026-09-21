import nodemailer from 'nodemailer';
import { config, smtpConfigured } from './config.js';

let transport = null;

function getTransport() {
  if (!smtpConfigured) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

export { smtpConfigured };

/** Reject anything that isn't a plausible single address. */
export function isEmail(value) {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(String(value || '').trim());
}

export function parseRecipients(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\n]/);
  const cleaned = raw.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  const valid = [...new Set(cleaned.filter(isEmail))];
  const invalid = cleaned.filter((value) => !isEmail(value));
  return { valid, invalid };
}

/**
 * Send one message. Throws with a readable message when SMTP isn't set up,
 * so the UI can tell a manager exactly what's missing.
 */
export async function sendMail({ to, subject, text, html }) {
  const mailer = getTransport();
  if (!mailer) {
    throw Object.assign(
      new Error('Email is not configured on this server. Set SMTP_HOST and MAIL_FROM, then restart.'),
      { status: 503 }
    );
  }
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) {
    throw Object.assign(new Error('No recipients to send to.'), { status: 400 });
  }

  const info = await mailer.sendMail({
    from: config.smtp.from,
    to: recipients.join(', '),
    subject,
    text,
    html,
  });

  return { messageId: info.messageId, accepted: info.accepted || recipients };
}

export async function verifyMailTransport() {
  const mailer = getTransport();
  if (!mailer) return { ok: false, reason: 'SMTP is not configured.' };
  try {
    await mailer.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
