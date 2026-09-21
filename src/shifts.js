import { db, nowIso, logEvent, transaction, getJsonSetting } from './db.js';
import { config } from './config.js';
import { SECTIONS, ITEM_INDEX, TOTAL_ITEMS, TEMPLATE_VERSION, isKnownItem } from './template.js';

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
export const shiftTypes = () => getJsonSetting('shift_types', ['AM', 'PM']);

export function getShift(id) {
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(id));
}

export function findShift({ location, businessDate, shiftType }) {
  return db
    .prepare('SELECT * FROM shifts WHERE location = ? AND business_date = ? AND shift_type = ?')
    .get(location, businessDate, shiftType);
}

/**
 * Return the shift for this location/date/type, creating it on first touch.
 * Two devices opening the same shift at once is normal and safe: the unique
 * index makes the loser of the race fall back to reading the winner's row.
 */
export function openShift({ location, businessDate, shiftType, user }) {
  const existing = findShift({ location, businessDate, shiftType });
  if (existing) return existing;

  try {
    const info = db
      .prepare(
        `INSERT INTO shifts(location, business_date, shift_type, template_version, status, opened_by, opened_at)
         VALUES(?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(location, businessDate, shiftType, TEMPLATE_VERSION, user.id, nowIso());
    const shift = getShift(Number(info.lastInsertRowid));
    logEvent({
      shiftId: shift.id,
      userId: user.id,
      type: 'shift_opened',
      detail: `${location} · ${businessDate} · ${shiftType}`,
    });
    return shift;
  } catch (error) {
    const raced = findShift({ location, businessDate, shiftType });
    if (raced) return raced;
    throw error;
  }
}

export function closeShift(shift, user, summary) {
  return transaction(() => {
    db.prepare('UPDATE shifts SET status = ?, closed_by = ?, closed_at = ?, summary = ? WHERE id = ?').run(
      'closed',
      user.id,
      nowIso(),
      String(summary || shift.summary || ''),
      shift.id
    );
    logEvent({ shiftId: shift.id, userId: user.id, type: 'shift_closed', detail: summary ? 'with summary' : '' });
    return getShift(shift.id);
  });
}

export function reopenShift(shift, user) {
  db.prepare('UPDATE shifts SET status = ?, closed_by = NULL, closed_at = NULL WHERE id = ?').run('open', shift.id);
  logEvent({ shiftId: shift.id, userId: user.id, type: 'shift_reopened' });
  return getShift(shift.id);
}

export function updateSummary(shift, user, summary) {
  db.prepare('UPDATE shifts SET summary = ? WHERE id = ?').run(String(summary || ''), shift.id);
  logEvent({ shiftId: shift.id, userId: user.id, type: 'summary_updated' });
  return getShift(shift.id);
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

function currentCheck(shiftId, itemKey) {
  return db.prepare('SELECT * FROM checks WHERE shift_id = ? AND item_key = ?').get(shiftId, itemKey);
}

function upsertCheck(shiftId, itemKey, fields) {
  const existing = currentCheck(shiftId, itemKey);
  if (existing) {
    const next = { ...existing, ...fields, updated_at: nowIso() };
    db.prepare(
      `UPDATE checks SET state = ?, note = ?, flagged = ?, checked_by = ?, checked_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(next.state, next.note, next.flagged ? 1 : 0, next.checked_by, next.checked_at, next.updated_at, existing.id);
    return currentCheck(shiftId, itemKey);
  }
  const row = {
    state: 'open',
    note: '',
    flagged: 0,
    checked_by: null,
    checked_at: null,
    ...fields,
  };
  db.prepare(
    `INSERT INTO checks(shift_id, item_key, state, note, flagged, checked_by, checked_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(shiftId, itemKey, row.state, row.note, row.flagged ? 1 : 0, row.checked_by, row.checked_at, nowIso());
  return currentCheck(shiftId, itemKey);
}

/** Tick, untick, or mark N/A. Stamps who and when on every completion. */
export function setCheckState(shift, itemKey, state, user) {
  if (!isKnownItem(itemKey)) throw Object.assign(new Error('Unknown checklist item.'), { status: 400 });
  if (!CHECK_STATES.includes(state)) throw Object.assign(new Error('Invalid state.'), { status: 400 });

  return transaction(() => {
    const isComplete = state !== 'open';
    const check = upsertCheck(shift.id, itemKey, {
      state,
      checked_by: isComplete ? user.id : null,
      checked_at: isComplete ? nowIso() : null,
    });
    const type = state === 'done' ? 'item_done' : state === 'na' ? 'item_na' : 'item_reopened';
    logEvent({ shiftId: shift.id, userId: user.id, type, itemKey, detail: ITEM_INDEX.get(itemKey).label });
    return check;
  });
}

export function setCheckNote(shift, itemKey, note, user) {
  if (!isKnownItem(itemKey)) throw Object.assign(new Error('Unknown checklist item.'), { status: 400 });
  const text = String(note || '').slice(0, 2000);

  return transaction(() => {
    const check = upsertCheck(shift.id, itemKey, { note: text });
    logEvent({
      shiftId: shift.id,
      userId: user.id,
      type: text ? 'note_added' : 'note_cleared',
      itemKey,
      detail: text,
    });
    return check;
  });
}

export function setCheckFlag(shift, itemKey, flagged, user) {
  if (!isKnownItem(itemKey)) throw Object.assign(new Error('Unknown checklist item.'), { status: 400 });

  return transaction(() => {
    const check = upsertCheck(shift.id, itemKey, { flagged: flagged ? 1 : 0 });
    logEvent({
      shiftId: shift.id,
      userId: user.id,
      type: flagged ? 'flag_raised' : 'flag_cleared',
      itemKey,
      detail: ITEM_INDEX.get(itemKey).label,
    });
    return check;
  });
}

/** A free-text entry in the running log, not tied to any checklist item. */
export function addLogEntry(shift, text, user) {
  const detail = String(text || '').trim().slice(0, 2000);
  if (!detail) throw Object.assign(new Error('Log entry cannot be empty.'), { status: 400 });
  logEvent({ shiftId: shift.id, userId: user.id, type: 'log_entry', detail });
  return detail;
}

/* ------------------------------------------------------------------ *
 * Reading a shift back out
 * ------------------------------------------------------------------ */

function userNames() {
  const rows = db.prepare('SELECT id, name FROM users').all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The full state of one shift: every template section with its items merged
 * against what's been checked, plus the running log and progress counts.
 */
export function shiftDetail(shiftId) {
  const shift = getShift(shiftId);
  if (!shift) return null;

  const names = userNames();
  const checkRows = db.prepare('SELECT * FROM checks WHERE shift_id = ?').all(shift.id);
  const byKey = new Map(checkRows.map((row) => [row.item_key, row]));

  let done = 0;
  let flagged = 0;

  const sections = SECTIONS.map((section) => {
    const items = section.items.map((item) => {
      const check = byKey.get(item.key);
      const state = check?.state || 'open';
      if (state !== 'open') done += 1;
      if (check?.flagged) flagged += 1;
      return {
        key: item.key,
        label: item.label,
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
      deckWalk: section.deckWalk || null,
      items,
      done: sectionDone,
      total: items.length,
      complete: sectionDone === items.length,
    };
  });

  const events = db
    .prepare('SELECT * FROM events WHERE shift_id = ? ORDER BY id DESC LIMIT 300')
    .all(shift.id)
    .map((event) => ({
      id: event.id,
      type: event.type,
      itemKey: event.item_key,
      itemLabel: event.item_key ? ITEM_INDEX.get(event.item_key)?.label || event.item_key : null,
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
    progress: { done, total: TOTAL_ITEMS, flagged, percent: Math.round((done / TOTAL_ITEMS) * 100) },
  };
}

export function listShifts({ location, from, to, limit = 60 } = {}) {
  const where = [];
  const params = [];
  if (location) {
    where.push('s.location = ?');
    params.push(location);
  }
  if (isBusinessDate(from)) {
    where.push('s.business_date >= ?');
    params.push(from);
  }
  if (isBusinessDate(to)) {
    where.push('s.business_date <= ?');
    params.push(to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT s.*,
              opener.name AS opened_by_name,
              closer.name AS closed_by_name,
              (SELECT COUNT(*) FROM checks c WHERE c.shift_id = s.id AND c.state <> 'open') AS done_count,
              (SELECT COUNT(*) FROM checks c WHERE c.shift_id = s.id AND c.flagged = 1) AS flag_count
       FROM shifts s
       LEFT JOIN users opener ON opener.id = s.opened_by
       LEFT JOIN users closer ON closer.id = s.closed_by
       ${clause}
       ORDER BY s.business_date DESC, s.shift_type ASC, s.id DESC
       LIMIT ?`
    )
    .all(...params, Math.min(Number(limit) || 60, 200))
    .map((row) => ({
      id: row.id,
      location: row.location,
      businessDate: row.business_date,
      businessDateLabel: formatBusinessDate(row.business_date),
      shiftType: row.shift_type,
      status: row.status,
      openedBy: row.opened_by_name,
      openedAtLabel: formatTime(row.opened_at),
      closedBy: row.closed_by_name,
      closedAtLabel: formatTime(row.closed_at),
      recapSentAt: row.recap_sent_at,
      done: row.done_count,
      total: TOTAL_ITEMS,
      flagged: row.flag_count,
      percent: Math.round((row.done_count / TOTAL_ITEMS) * 100),
    }));
}
