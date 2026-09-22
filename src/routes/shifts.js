import express from 'express';
import { requireAuth, requireRole, hasRole, publicUser, userLocations, canUseLocation, isUnrestricted } from '../auth.js';
import { getJsonSetting, getSetting } from '../db.js';
import { config, smtpConfigured } from '../config.js';
import { getTemplate, isKnownTemplate, templateSummaries, DEFAULT_TEMPLATE_KEY } from '../template.js';
import {
  openShift,
  getShift,
  deleteShift,
  markRecapSent,
  shiftDetail,
  listShifts,
  closeShift,
  reopenShift,
  updateSummary,
  setCheckState,
  setCheckNote,
  setCheckFlag,
  addLogEntry,
  businessDateFor,
  isBusinessDate,
  locations,
} from '../shifts.js';
import { buildRecap, recapHtml, recapText } from '../recap.js';
import { deckWalkGuide } from '../deck-walk.js';
import { sendMail, parseRecipients } from '../mail.js';
import { ah, fail } from './helpers.js';

export const shiftsRouter = express.Router();

/**
 * Everything the client needs on load: who you are, and how this shop is set up.
 * Declared before the auth gate below so an anonymous visitor gets a plain
 * `user: null` instead of a 401 the browser logs as an error on every load.
 */
shiftsRouter.get(
  '/bootstrap',
  ah(async (req, res) => {
    if (!req.user) {
      return res.json({
        user: null,
        brandName: config.brandName,
        logoUrl: await getSetting('brand_logo_url', ''),
      });
    }
    res.json({
      user: publicUser(req.user),
      brandName: config.brandName,
      logoUrl: await getSetting('brand_logo_url', ''),
      timezone: config.timezone,
      today: businessDateFor(),
      locations: await visibleLocations(req.user),
      allLocations: hasRole(req.user, 'admin') ? await locations() : undefined,
      logs: templateSummaries(),
      defaultLog: DEFAULT_TEMPLATE_KEY,
      emailEnabled: smtpConfigured,
      defaultRecipients: hasRole(req.user, 'manager') ? await getJsonSetting('recap_recipients', []) : [],
    });
  })
);

// Everything below this line requires a signed-in user.
shiftsRouter.use(requireAuth);

/** The locations this account may open shifts for, in configured order. */
async function visibleLocations(user) {
  const configured = await locations();
  if (isUnrestricted(user)) return configured;
  const allowed = userLocations(user);
  return configured.filter((location) => allowed.includes(location));
}

/** The Deck Walk route: reference material, the same for everyone. */
shiftsRouter.get(
  '/deck-walk',
  ah((_req, res) => {
    res.json(deckWalkGuide());
  })
);

/** Load a shift and make sure it's writable before a mutation goes through. */
async function loadShift(req, { mustBeOpen = false } = {}) {
  const shift = await getShift(req.params.id);
  if (!shift) fail(404, 'That shift does not exist.');
  if (!canUseLocation(req.user, shift.location)) {
    fail(403, `You are not assigned to ${shift.location}.`);
  }
  if (mustBeOpen && shift.status !== 'open') {
    fail(409, 'This shift is closed. A manager can reopen it if something needs changing.');
  }
  return shift;
}

shiftsRouter.get(
  '/shifts',
  ah(async (req, res) => {
    res.json({
      shifts: await listShifts({
        location: req.query.location || undefined,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
        onlyLocations: isUnrestricted(req.user) ? null : userLocations(req.user),
      }),
    });
  })
);

/** Open today's card, or return the one already running for that slot. */
shiftsRouter.post(
  '/shifts',
  ah(async (req, res) => {
    const location = String(req.body?.location || '').trim();
    const templateKey = String(req.body?.templateKey || DEFAULT_TEMPLATE_KEY).trim();
    const businessDate = String(req.body?.businessDate || businessDateFor()).trim();

    if (!(await locations()).includes(location)) fail(400, 'Pick a valid location.');
    if (!canUseLocation(req.user, location)) fail(403, `You are not assigned to ${location}.`);
    if (!isKnownTemplate(templateKey)) fail(400, 'Pick a valid log — opening or closing.');
    if (!isBusinessDate(businessDate)) fail(400, 'Business date must look like YYYY-MM-DD.');

    const shift = await openShift({ location, businessDate, templateKey, user: req.user });
    res.json(await shiftDetail(shift.id));
  })
);

shiftsRouter.get(
  '/shifts/:id',
  ah(async (req, res) => {
    const shift = await loadShift(req);
    res.json(await shiftDetail(shift.id));
  })
);

shiftsRouter.post(
  '/shifts/:id/items/:itemKey/state',
  ah(async (req, res) => {
    const shift = await loadShift(req, { mustBeOpen: true });
    await setCheckState(shift, req.params.itemKey, String(req.body?.state || 'done'), req.user);
    res.json(await shiftDetail(shift.id));
  })
);

shiftsRouter.post(
  '/shifts/:id/items/:itemKey/note',
  ah(async (req, res) => {
    const shift = await loadShift(req, { mustBeOpen: true });
    await setCheckNote(shift, req.params.itemKey, req.body?.note, req.user);
    res.json(await shiftDetail(shift.id));
  })
);

shiftsRouter.post(
  '/shifts/:id/items/:itemKey/flag',
  ah(async (req, res) => {
    const shift = await loadShift(req, { mustBeOpen: true });
    await setCheckFlag(shift, req.params.itemKey, Boolean(req.body?.flagged), req.user);
    res.json(await shiftDetail(shift.id));
  })
);

shiftsRouter.post(
  '/shifts/:id/log',
  ah(async (req, res) => {
    const shift = await loadShift(req, { mustBeOpen: true });
    await addLogEntry(shift, req.body?.text, req.user);
    res.json(await shiftDetail(shift.id));
  })
);

shiftsRouter.post(
  '/shifts/:id/summary',
  ah(async (req, res) => {
    const shift = await loadShift(req, { mustBeOpen: true });
    await updateSummary(shift, req.user, req.body?.summary);
    res.json(await shiftDetail(shift.id));
  })
);

/** Close the shift, optionally emailing the recap in the same tap. */
shiftsRouter.post(
  '/shifts/:id/close',
  requireRole('manager'),
  ah(async (req, res) => {
    const shift = await loadShift(req, { mustBeOpen: true });
    await closeShift(shift, req.user, req.body?.summary);

    let email = { attempted: false };
    if (req.body?.sendRecap) {
      email = await deliverRecap(shift.id, req.body?.recipients, req.user);
    }

    res.json({ ...(await shiftDetail(shift.id)), email });
  })
);

shiftsRouter.post(
  '/shifts/:id/reopen',
  requireRole('manager'),
  ah(async (req, res) => {
    const shift = await loadShift(req);
    if (shift.status === 'open') fail(409, 'That shift is already open.');
    await reopenShift(shift, req.user);
    res.json(await shiftDetail(shift.id));
  })
);

/** Permanent, and admin-only: it takes the checks and the running log with it. */
shiftsRouter.delete(
  '/shifts/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const shift = await loadShift(req);
    const deleted = await deleteShift(shift, req.user);
    res.json({ deleted: true, description: deleted });
  })
);

shiftsRouter.post(
  '/shifts/:id/recap/email',
  requireRole('manager'),
  ah(async (req, res) => {
    const shift = await loadShift(req);
    const email = await deliverRecap(shift.id, req.body?.recipients, req.user);
    res.json({ ...(await shiftDetail(shift.id)), email });
  })
);

/** Printable / viewable recap — handy for taping to the office wall. */
shiftsRouter.get(
  '/shifts/:id/recap.html',
  ah(async (req, res) => {
    const shift = await loadShift(req);
    const recap = await buildRecap(shift.id);
    if (!recap) fail(404, 'That shift does not exist.');
    res.type('html').send(recapHtml(recap));
  })
);

shiftsRouter.get(
  '/shifts/:id/recap.txt',
  ah(async (req, res) => {
    const shift = await loadShift(req);
    const recap = await buildRecap(shift.id);
    if (!recap) fail(404, 'That shift does not exist.');
    res.type('text/plain; charset=utf-8').send(recapText(recap));
  })
);

async function deliverRecap(shiftId, recipientsInput, user) {
  const recap = await buildRecap(shiftId);
  if (!recap) fail(404, 'That shift does not exist.');

  const source = recipientsInput ?? (await getJsonSetting('recap_recipients', []));
  const { valid, invalid } = parseRecipients(source);

  if (!valid.length) {
    fail(
      400,
      invalid.length
        ? `No valid recipients. Check: ${invalid.join(', ')}`
        : 'No recap recipients set. Add them under Settings, or type them in before sending.'
    );
  }

  await sendMail({
    to: valid,
    subject: recap.subject,
    text: recapText(recap),
    html: recapHtml(recap),
  });

  await markRecapSent(shiftId, user, valid);

  return { attempted: true, sent: true, recipients: valid, invalid };
}
