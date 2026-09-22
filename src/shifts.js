import { query, one, all, nowIso, logEvent, transaction, getJsonSetting } from './db.js';
import { config } from './config.js';
import {
  getTemplate,
  findItem,
  totalItems,
  isKnownItem,
  isKnownTemplate,
  TEMPLATE_VERSION,
  DEFAULT_TEMPLATE_KEY,
  templateSummaries,
} from './template.js';

export const CHECK_STATES = ['open', 'done', 'na'];

/* ------------------------------------------------------------------ *
 * Dates & times, always in the restaurant's timezone
 * ------------------------------------------------------------------ */

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone,
  hour: 'numeric',
  minute: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** The operating date ("business date") for an instant, in restaurant time. */
export function businessDateFor(date = new Date()) {
  return dateFormatter.format(date);
}

export function formatTime(iso) {
  return iso ? timeFormatter.format(new Date(iso)) : '';
}

export function formatDateTime(iso) {
  return iso ? dateTimeFormatter.format(new Date(iso)) : '';
}

export function formatBusinessDate(businessDate) {
  // Parse as noon UTC so the date never slips a day when formatted in-zone.
  const d = new Date(`${businessDate}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export const isBusinessDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

/* ------------------------------------------------------------------ *
 * Shifts
 * ------------------------------------------------------------------ */

export const locations = () => getJsonSetting('locations', ['Point Loma', 'Pacific Beach']);

/** The logs a manager can run — one card per key. */
export const shiftLogs = () => templateSummaries();

export async function getShift(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return undefined;
  return one('SELECT * FROM shifts WHERE id = $1', [numeric]);
}

export async function findShift({ location, businessDate, shiftType }) {
  return one('SELECT * FROM shifts WHERE location = $1 AND business_date = $2 AND shift_type = $3', [
    location,
    businessDate,
    shiftType,
  ]);
}

/**
 * Return the shift for this location/date/type, creating it on first touch.
 * Two devices opening the same shift at once is normal: ON CONFLICT makes the
 * insert a no-op for the loser, who then reads the winner's row.
 */
export async function openShift({ location, businessDate, templateKey, user }) {
  const template = getTemplate(templateKey);
  const shiftType = template.name;

  const inserted = await one(
    `INSERT INTO shifts(location, business_date, shift_type, template_key, template_version, status, opened_by, opened_at)
     VALUES($1, $2, $3, $4, $5, 'open', $6, $7)
     ON CONFLICT (location, business_date, shift_type) DO NOTHING
     RETURNING *`,
    [location, businessDate, shiftType, template.key, TEMPLATE_VERSION, user.id, nowIso()]
  );

  if (inserted) {
    await logEvent({
      shiftId: inserted.id,
      userId: user.id,
      type: 'shift_opened',
      detail: `${location} · ${businessDate} · ${template.name}`,
    });
    return inserted;
  }

  return findShift({ location, businessDate, shiftType });
}

export async function closeShift(shift, user, summary) {
  await transaction(async (tx) => {
    await tx.query('UPDATE shifts SET status = $1, closed_by = $2, closed_at = $3, summary = $4 WHERE id = $5', [
      'closed',
      user.id,
      nowIso(),
      String(summary ?? shift.summary ?? ''),
      shift.id,
    ]);
    await logEvent(
      { shiftId: shift.id, userId: user.id, type: 'shift_closed', detail: summary ? 'with summary' : '' },
      tx
    );
  });
  return getShift(shift.id);
}

export async function reopenShift(shift, user) {
  await transaction(async (tx) => {
    await tx.query('UPDATE shifts SET status = $1, closed_by = NULL, closed_at = NULL WHERE id = $2', [
      'open',
      shift.id,
    ]);
    await logEvent({ shiftId: shift.id, userId: user.id, type: 'shift_reopened' }, tx);
  });
  return getShift(shift.id);
}

export async function updateSummary(shift, user, summary) {
  await transaction(async (tx) => {
    await tx.query('UPDATE shifts SET summary = $1 WHERE id = $2', [String(summary || ''), shift.id]);
    await logEvent({ shiftId: shift.id, userId: user.id, type: 'summary_updated' }, tx);
  });
  return getShift(shift.id);
}

/**
 * Delete a shift and everything logged against it. Checks and events cascade
 * with the row, so the audit entry is written against no shift at all —
 * otherwise the record of the deletion would vanish along with it.
 */
export async function deleteShift(shift, user) {
  const description = `${shift.location} · ${getTemplate(shift.template_key).name} · ${shift.business_date}`;

  await transaction(async (tx) => {
    await tx.query('DELETE FROM shifts WHERE id = $1', [shift.id]);
    await logEvent(
      { shiftId: null, userId: user.id, type: 'shift_deleted', detail: description },
      tx
    );
  });

  return description;
}

export async function markRecapSent(shiftId, user, recipients) {
  await transaction(async (tx) => {
    await tx.query('UPDATE shifts SET recap_sent_at = $1 WHERE id = $2', [nowIso(), Number(shiftId)]);
    await logEvent(
      { shiftId: Number(shiftId), userId: user.id, type: 'recap_sent', detail: recipients.join(', ') },
      tx
    );
  });
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

/** An item only exists relative to the card the shift is running. */
function assertItem(shift, itemKey) {
  if (!isKnownItem(shift.template_key, itemKey)) {
    throw Object.assign(new Error('Unknown checklist item.'), { status: 400 });
  }
}

/**
 * Create or update one item's row in a single statement. Doing this as an
 * upsert rather than read-then-write keeps two devices touching the same item
 * at the same moment from racing each other.
 */
async function upsertCheck(tx, shiftId, itemKey, fields) {
  const sets = [];
  const values = [shiftId, itemKey, nowIso()];
  for (const [column, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }

  const insertColumns = ['shift_id', 'item_key', 'updated_at', ...Object.keys(fields)];
  const insertPlaceholders = insertColumns.map((_, index) => `$${index + 1}`);

  const row = await tx.query(
    `INSERT INTO checks(${insertColumns.join(', ')})
     VALUES(${insertPlaceholders.join(', ')})
     ON CONFLICT (shift_id, item_key) DO UPDATE SET ${sets.join(', ')}, updated_at = $3
     RETURNING *`,
    values
  );
  return row.rows[0];
}

/** Tick, untick, or mark N/A. Stamps who and when on every completion. */
export async function setCheckState(shift, itemKey, state, user) {
  assertItem(shift, itemKey);
  if (!CHECK_STATES.includes(state)) throw Object.assign(new Error('Invalid state.'), { status: 400 });

  return transaction(async (tx) => {
    const isComplete = state !== 'open';
    const check = await upsertCheck(tx, shift.id, itemKey, {
      state,
      checked_by: isComplete ? user.id : null,
      checked_at: isComplete ? nowIso() : null,
    });
    const type = state === 'done' ? 'item_done' : state === 'na' ? 'item_na' : 'item_reopened';
    await logEvent(
      { shiftId: shift.id, userId: user.id, type, itemKey, detail: findItem(shift.template_key, itemKey).label },
      tx
    );
    return check;
  });
}

export async function setCheckNote(shift, itemKey, note, user) {
  assertItem(shift, itemKey);
  const text = String(note || '').slice(0, 2000);

  return transaction(async (tx) => {
    const check = await upsertCheck(tx, shift.id, itemKey, { note: text });
    await logEvent(
      { shiftId: shift.id, userId: user.id, type: text ? 'note_added' : 'note_cleared', itemKey, detail: text },
      tx
    );
    return check;
  });
}

export async function setCheckFlag(shift, itemKey, flagged, user) {
  assertItem(shift, itemKey);

  return transaction(async (tx) => {
    const check = await upsertCheck(tx, shift.id, itemKey, { flagged: Boolean(flagged) });
    await logEvent(
      {
        shiftId: shift.id,
        userId: user.id,
        type: flagged ? 'flag_raised' : 'flag_cleared',
        itemKey,
        detail: findItem(shift.template_key, itemKey).label,
      },
      tx
    );
    return check;
  });
}

/** A free-text entry in the running log, not tied to any checklist item. */
export async function addLogEntry(shift, text, user) {
  const detail = String(text || '').trim().slice(0, 2000);
  if (!detail) throw Object.assign(new Error('Log entry cannot be empty.'), { status: 400 });
  await logEvent({ shiftId: shift.id, userId: user.id, type: 'log_entry', detail });
  return detail;
}

/* ------------------------------------------------------------------ *
 * Reading a shift back out
 * ------------------------------------------------------------------ */

async function userNames() {
  const rows = await all('SELECT id, name FROM users');
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The full state of one shift: every template section with its items merged
 * against what's been checked, plus the running log and progress counts.
 */
export async function shiftDetail(shiftId) {
  const shift = await getShift(shiftId);
  if (!shift) return null;

  const [names, checkRows, eventRows] = await Promise.all([
    userNames(),
    all('SELECT * FROM checks WHERE shift_id = $1', [shift.id]),
    all('SELECT * FROM events WHERE shift_id = $1 ORDER BY id DESC LIMIT 300', [shift.id]),
  ]);

  const byKey = new Map(checkRows.map((row) => [row.item_key, row]));
  const template = getTemplate(shift.template_key);

  let done = 0;
  let flagged = 0;

  const sections = template.sections.map((section) => {
    const items = section.items.map((item) => {
      const check = byKey.get(item.key);
      const state = check?.state || 'open';
      if (state !== 'open') done += 1;
      if (check?.flagged) flagged += 1;
      return {
        key: item.key,
        label: item.label,
        deckWalk: item.deckWalk || null,
        state,
        note: check?.note || '',
        flagged: Boolean(check?.flagged),
        checkedBy: check?.checked_by ? names.get(check.checked_by) || 'Unknown' : null,
        checkedAt: check?.checked_at || null,
        checkedAtLabel: formatTime(check?.checked_at),
      };
    });
    const sectionDone = items.filter((i) => i.state !== 'open').length;
    return {
      key: section.key,
      title: section.title,
      blurb: section.blurb || '',
      items,
      done: sectionDone,
      total: items.length,
      complete: sectionDone === items.length,
    };
  });

  const events = eventRows.map((event) => ({
    id: event.id,
    type: event.type,
    itemKey: event.item_key,
    itemLabel: event.item_key ? findItem(shift.template_key, event.item_key)?.label || event.item_key : null,
    detail: event.detail,
    user: event.user_id ? names.get(event.user_id) || 'Unknown' : 'System',
    createdAt: event.created_at,
    timeLabel: formatTime(event.created_at),
  }));

  return {
    shift: {
      id: shift.id,
      location: shift.location,
      businessDate: shift.business_date,
      businessDateLabel: formatBusinessDate(shift.business_date),
      shiftType: shift.shift_type,
      templateKey: shift.template_key,
      templateName: template.name,
      status: shift.status,
      summary: shift.summary,
      openedBy: shift.opened_by ? names.get(shift.opened_by) || 'Unknown' : null,
      openedAt: shift.opened_at,
      openedAtLabel: formatTime(shift.opened_at),
      closedBy: shift.closed_by ? names.get(shift.closed_by) || 'Unknown' : null,
      closedAt: shift.closed_at,
      closedAtLabel: formatTime(shift.closed_at),
      recapSentAt: shift.recap_sent_at,
      recapSentAtLabel: formatDateTime(shift.recap_sent_at),
    },
    sections,
    events,
    progress: {
      done,
      total: template.sections.reduce((sum, section) => sum + section.items.length, 0),
      flagged,
      percent: Math.round((done / totalItems(shift.template_key)) * 100),
    },
  };
}

export async function listShifts({ location, from, to, limit = 60, onlyLocations = null } = {}) {
  const where = [];
  const params = [];

  if (location) {
    params.push(location);
    where.push(`s.location = $${params.length}`);
  }
  // A restricted account only ever sees its own locations' shifts.
  if (Array.isArray(onlyLocations) && onlyLocations.length) {
    params.push(onlyLocations);
    where.push(`s.location = ANY($${params.length})`);
  }
  if (isBusinessDate(from)) {
    params.push(from);
    where.push(`s.business_date >= $${params.length}`);
  }
  if (isBusinessDate(to)) {
    params.push(to);
    where.push(`s.business_date <= $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 60, 200));

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await all(
    `SELECT s.*,
            opener.name AS opened_by_name,
            closer.name AS closed_by_name,
            (SELECT COUNT(*)::int FROM checks c WHERE c.shift_id = s.id AND c.state <> 'open') AS done_count,
            (SELECT COUNT(*)::int FROM checks c WHERE c.shift_id = s.id AND c.flagged = TRUE) AS flag_count
     FROM shifts s
     LEFT JOIN users opener ON opener.id = s.opened_by
     LEFT JOIN users closer ON closer.id = s.closed_by
     ${clause}
     ORDER BY s.business_date DESC, s.shift_type ASC, s.id DESC
     LIMIT $${params.length}`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    location: row.location,
    businessDate: row.business_date,
    businessDateLabel: formatBusinessDate(row.business_date),
    shiftType: row.shift_type,
    templateKey: row.template_key,
    templateName: getTemplate(row.template_key).name,
    status: row.status,
    openedBy: row.opened_by_name,
    openedAtLabel: formatTime(row.opened_at),
    closedBy: row.closed_by_name,
    closedAtLabel: formatTime(row.closed_at),
    recapSentAt: row.recap_sent_at,
    done: row.done_count,
    total: totalItems(row.template_key),
    flagged: row.flag_count,
    percent: Math.round((row.done_count / totalItems(row.template_key)) * 100),
  }));
}
