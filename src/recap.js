import { config } from './config.js';
import { shiftDetail, formatDateTime } from './shifts.js';

export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const NAVY = '#26418f';
const INK = '#1c2434';
const MUTED = '#5c6880';
const LINE = '#dfe4ee';

/**
 * Gather everything worth putting in front of the next manager: what was
 * missed, what was flagged, every note left on the card, and the timeline.
 */
export async function buildRecap(shiftId) {
  const detail = await shiftDetail(shiftId);
  if (!detail) return null;

  const { shift, sections, events, progress } = detail;

  const incomplete = [];
  const flagged = [];
  const notes = [];
  const skipped = [];

  for (const section of sections) {
    for (const item of section.items) {
      const entry = { ...item, sectionTitle: section.title };
      if (item.state === 'open') incomplete.push(entry);
      if (item.state === 'na') skipped.push(entry);
      if (item.flagged) flagged.push(entry);
      if (item.note) notes.push(entry);
    }
  }

  const subject = `${shift.location} · ${shift.shiftType} shift recap · ${shift.businessDateLabel}`;

  return {
    shift,
    sections,
    progress,
    incomplete,
    skipped,
    flagged,
    notes,
    // Oldest-first reads like a shift diary.
    timeline: [...events].reverse(),
    subject,
    url: `${config.appUrl}/shift/${shift.id}`,
  };
}

/* ------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------ */

export function recapText(recap) {
  const { shift, progress } = recap;
  const lines = [];

  lines.push(recap.subject);
  lines.push('='.repeat(Math.min(recap.subject.length, 70)));
  lines.push('');
  lines.push(`Opened by:  ${shift.openedBy || '—'} at ${shift.openedAtLabel || '—'}`);
  lines.push(`Closed by:  ${shift.closedBy || '— still open —'}${shift.closedAtLabel ? ` at ${shift.closedAtLabel}` : ''}`);
  lines.push(`Completed:  ${progress.done} of ${progress.total} items (${progress.percent}%)`);
  lines.push('');

  if (shift.summary) {
    lines.push('SHIFT SUMMARY');
    lines.push(shift.summary);
    lines.push('');
  }

  if (recap.flagged.length) {
    lines.push(`NEEDS ATTENTION (${recap.flagged.length})`);
    for (const item of recap.flagged) {
      lines.push(`  ! ${item.sectionTitle}: ${item.label}`);
      if (item.note) lines.push(`      ${item.note}`);
    }
    lines.push('');
  }

  if (recap.incomplete.length) {
    lines.push(`NOT COMPLETED (${recap.incomplete.length})`);
    for (const item of recap.incomplete) lines.push(`  [ ] ${item.sectionTitle}: ${item.label}`);
    lines.push('');
  } else {
    lines.push('NOT COMPLETED: none — full card cleared.');
    lines.push('');
  }

  if (recap.skipped.length) {
    lines.push(`MARKED N/A (${recap.skipped.length})`);
    for (const item of recap.skipped) {
      lines.push(`  — ${item.sectionTitle}: ${item.label}${item.note ? ` (${item.note})` : ''}`);
    }
    lines.push('');
  }

  if (recap.notes.length) {
    lines.push(`NOTES (${recap.notes.length})`);
    for (const item of recap.notes) {
      lines.push(`  ${item.label} — ${item.checkedBy || 'unassigned'}${item.checkedAtLabel ? ` @ ${item.checkedAtLabel}` : ''}`);
      lines.push(`      ${item.note}`);
    }
    lines.push('');
  }

  lines.push('SECTION PROGRESS');
  for (const section of recap.sections) {
    const mark = section.complete ? 'x' : ' ';
    lines.push(`  [${mark}] ${section.title}: ${section.done}/${section.total}`);
  }
  lines.push('');

  lines.push('RUNNING LOG');
  for (const event of recap.timeline) {
    lines.push(`  ${event.timeLabel}  ${event.user} — ${describeEvent(event)}`);
  }
  lines.push('');
  lines.push(`Full shift: ${recap.url}`);

  return lines.join('\n');
}

export function describeEvent(event) {
  switch (event.type) {
    case 'shift_opened':
      return `opened the shift (${event.detail})`;
    case 'shift_closed':
      return 'closed the shift';
    case 'shift_reopened':
      return 'reopened the shift';
    case 'item_done':
      return `checked off "${event.itemLabel}"`;
    case 'item_na':
      return `marked "${event.itemLabel}" N/A`;
    case 'item_reopened':
      return `unchecked "${event.itemLabel}"`;
    case 'note_added':
      return `noted on "${event.itemLabel}": ${event.detail}`;
    case 'note_cleared':
      return `cleared the note on "${event.itemLabel}"`;
    case 'flag_raised':
      return `flagged "${event.itemLabel}" for attention`;
    case 'flag_cleared':
      return `cleared the flag on "${event.itemLabel}"`;
    case 'log_entry':
      return event.detail;
    case 'summary_updated':
      return 'updated the shift summary';
    case 'recap_sent':
      return `emailed the recap (${event.detail})`;
    default:
      return event.detail || event.type;
  }
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

const block = (title, bodyHtml, accent = NAVY) => `
  <tr><td style="padding:22px 24px 0 24px;">
    <div style="font:700 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:${accent};padding-bottom:10px;">${escapeHtml(title)}</div>
    ${bodyHtml}
  </td></tr>`;

export function recapHtml(recap) {
  const { shift, progress } = recap;

  const stat = (label, value) => `
    <td style="padding:0 14px 0 0;vertical-align:top;">
      <div style="font:600 11px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.07em;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</div>
      <div style="font:600 15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};padding-top:3px;">${escapeHtml(value)}</div>
    </td>`;

  const list = (items, render) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${items.map(render).join('')}</table>`;

  const parts = [];

  parts.push(`
    <tr><td style="padding:24px 24px 0 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        ${stat('Opened', `${shift.openedBy || '—'} · ${shift.openedAtLabel || '—'}`)}
        ${stat('Closed', shift.closedBy ? `${shift.closedBy} · ${shift.closedAtLabel}` : 'Still open')}
        ${stat('Complete', `${progress.done}/${progress.total} · ${progress.percent}%`)}
      </tr></table>
      <div style="margin-top:16px;height:8px;border-radius:99px;background:${LINE};overflow:hidden;">
        <div style="height:8px;width:${progress.percent}%;background:${NAVY};border-radius:99px;"></div>
      </div>
    </td></tr>`);

  if (shift.summary) {
    parts.push(
      block(
        'Shift summary',
        `<div style="font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};white-space:pre-wrap;background:#f6f8fc;border-left:3px solid ${NAVY};padding:12px 14px;border-radius:0 6px 6px 0;">${escapeHtml(shift.summary)}</div>`
      )
    );
  }

  if (recap.flagged.length) {
    parts.push(
      block(
        `Needs attention (${recap.flagged.length})`,
        list(
          recap.flagged,
          (item) => `
          <tr><td style="padding:0 0 8px 0;">
            <div style="background:#fff5f5;border:1px solid #f3c9c9;border-radius:8px;padding:11px 13px;">
              <div style="font:600 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#9b2226;">${escapeHtml(item.label)}</div>
              <div style="font:400 12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};padding-top:2px;">${escapeHtml(item.sectionTitle)}</div>
              ${item.note ? `<div style="font:400 14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};padding-top:6px;white-space:pre-wrap;">${escapeHtml(item.note)}</div>` : ''}
            </div>
          </td></tr>`
        ),
        '#9b2226'
      )
    );
  }

  parts.push(
    block(
      recap.incomplete.length ? `Not completed (${recap.incomplete.length})` : 'Not completed',
      recap.incomplete.length
        ? list(
            recap.incomplete,
            (item) => `
          <tr><td style="padding:0 0 6px 0;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
            <span style="color:#b9c0cf;">☐</span> ${escapeHtml(item.label)}
            <span style="color:${MUTED};font-size:12px;"> · ${escapeHtml(item.sectionTitle)}</span>
          </td></tr>`
          )
        : `<div style="font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d7a4c;">Full card cleared — every item accounted for.</div>`
    )
  );

  if (recap.skipped.length) {
    parts.push(
      block(
        `Marked N/A (${recap.skipped.length})`,
        list(
          recap.skipped,
          (item) => `
        <tr><td style="padding:0 0 6px 0;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
          — ${escapeHtml(item.label)}${item.note ? ` <span style="color:${INK};">(${escapeHtml(item.note)})</span>` : ''}
        </td></tr>`
        )
      )
    );
  }

  if (recap.notes.length) {
    parts.push(
      block(
        `Notes (${recap.notes.length})`,
        list(
          recap.notes,
          (item) => `
        <tr><td style="padding:0 0 10px 0;">
          <div style="font:600 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">${escapeHtml(item.label)}</div>
          <div style="font:400 14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};padding-top:3px;white-space:pre-wrap;">${escapeHtml(item.note)}</div>
          <div style="font:400 12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};padding-top:3px;">${escapeHtml(item.checkedBy || 'unassigned')}${item.checkedAtLabel ? ` · ${escapeHtml(item.checkedAtLabel)}` : ''}</div>
        </td></tr>`
        )
      )
    );
  }

  parts.push(
    block(
      'Section progress',
      list(
        recap.sections,
        (section) => `
      <tr>
        <td style="padding:0 0 6px 0;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
          ${section.complete ? '<span style="color:#1d7a4c;">☑</span>' : '<span style="color:#b9c0cf;">☐</span>'} ${escapeHtml(section.title)}
          ${section.deckWalk ? `<span style="color:${NAVY};font-size:12px;font-weight:600;"> · Deck Walk ${section.deckWalk.number}</span>` : ''}
        </td>
        <td align="right" style="padding:0 0 6px 0;font:600 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${section.complete ? '#1d7a4c' : MUTED};">${section.done}/${section.total}</td>
      </tr>`
      )
    )
  );

  parts.push(
    block(
      'Running log',
      list(
        recap.timeline,
        (event) => `
      <tr>
        <td width="62" valign="top" style="padding:0 8px 5px 0;font:600 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};white-space:nowrap;">${escapeHtml(event.timeLabel)}</td>
        <td valign="top" style="padding:0 0 5px 0;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK};">
          <strong style="font-weight:600;">${escapeHtml(event.user)}</strong> ${escapeHtml(describeEvent(event))}
        </td>
      </tr>`
      )
    )
  );

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(recap.subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#eef1f7;padding:20px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(20,30,60,.12);">
        <tr><td style="background:${NAVY};padding:20px 24px;">
          <div style="font:700 11px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#aebbe4;">${escapeHtml(config.brandName)}</div>
          <div style="font:700 21px/1.35 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;padding-top:5px;">${escapeHtml(shift.location)} · ${escapeHtml(shift.shiftType)} Shift</div>
          <div style="font:400 14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#cdd7f0;padding-top:2px;">${escapeHtml(shift.businessDateLabel)}</div>
        </td></tr>
        ${parts.join('')}
        <tr><td style="padding:22px 24px 24px 24px;">
          <a href="${escapeHtml(recap.url)}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font:600 14px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:12px 20px;border-radius:8px;">Open the full shift log</a>
          <div style="font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};padding-top:14px;">Sent ${escapeHtml(formatDateTime(new Date().toISOString()))} from ${escapeHtml(config.brandName)}.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
