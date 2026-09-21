/* ------------------------------------------------------------------ *
 * Fish Shop Captain's Log — client.
 * No build step: this is plain ES modules served straight to the device.
 * ------------------------------------------------------------------ */

const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  boot: null,       // user, locations, shift types, template
  detail: null,     // the shift currently on screen
  collapsed: new Set(JSON.parse(localStorage.getItem('fscl.collapsed') || '[]')),
  pollTimer: null,
};

/* ------------------------------- icons ------------------------------ */

const CHECK_SVG = `<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>`;
const DASH_SVG = `<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M5 10h10"/></svg>`;
const NOTE_SVG = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z"/></svg>`;
const FLAG_SVG = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4"/><path d="M4 4.5h11l-1.6 3.6L15 12H4z"/></svg>`;
const BACK_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`;
const MENU_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;

/* ------------------------------- utils ------------------------------ */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

let toastTimer;
function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, bad ? 4200 : 2200);
}

function buzz(ms = 8) {
  if (navigator.vibrate) {
    try { navigator.vibrate(ms); } catch { /* not supported */ }
  }
}

/* -------------------------------- api ------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    state.boot = null;
    stopPolling();
    renderLogin();
    throw new Error('Signed out.');
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status}).`);
  return payload;
}

/* ------------------------------ routing ----------------------------- */

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}

window.addEventListener('popstate', () => route());

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

async function route() {
  stopPolling();
  const path = location.pathname;

  if (!state.boot) {
    try {
      state.boot = await api('/bootstrap');
    } catch (error) {
      appEl.innerHTML = `<div class="boot">${esc(error.message)}</div>`;
      return;
    }
  }

  if (!state.boot.user) {
    state.boot = null;
    return renderLogin();
  }

  if (state.boot.user.mustChangePassword) return renderPasswordChange();

  const shiftMatch = path.match(/^\/shift\/(\d+)$/);
  if (shiftMatch) return renderShift(Number(shiftMatch[1]));
  if (path === '/history') return renderHistory();
  if (path === '/settings') return renderSettings();
  return renderHome();
}

/* ------------------------------- sheet ------------------------------ */

function openSheet(html, wire) {
  document.querySelector('.sheet-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  document.body.appendChild(backdrop);
  wire?.(backdrop.querySelector('.sheet'), close);
  backdrop.querySelector('input, textarea, button:not([data-close])')?.focus();
  return close;
}

function confirmSheet({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openSheet(
      `<h2>${esc(title)}</h2>
       ${body ? `<p class="muted small">${esc(body)}</p>` : ''}
       <div class="row" style="margin-top:16px;">
         <button class="btn secondary grow" data-close>Cancel</button>
         <button class="btn grow${danger ? ' danger' : ''}" data-go>${esc(confirmLabel)}</button>
       </div>`,
      (sheet, close) => {
        sheet.querySelector('[data-go]').addEventListener('click', () => { close(); resolve(true); });
        sheet.closest('.sheet-backdrop').addEventListener('click', (event) => {
          if (event.target.closest('[data-close]') || event.target.classList.contains('sheet-backdrop')) resolve(false);
        });
      }
    );
  });
}

/* ------------------------------ polling ----------------------------- */

function startPolling(shiftId) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (document.hidden || document.querySelector('.sheet-backdrop')) return;
    try {
      const fresh = await api(`/shifts/${shiftId}`);
      // Don't clobber the screen while someone is mid-typing.
      if (document.activeElement?.matches('input, textarea')) return;
      if (JSON.stringify(fresh) !== JSON.stringify(state.detail)) {
        state.detail = fresh;
        paintShift();
      }
    } catch { /* offline or signed out; the next tick retries */ }
  }, 20000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !state.detail) return;
  try {
    state.detail = await api(`/shifts/${state.detail.shift.id}`);
    paintShift();
  } catch { /* ignore */ }
});

/* ------------------------------- chrome ----------------------------- */

function appbar({ title, sub = '', back = null, actions = '', progress = null }) {
  return `
    <header class="appbar">
      <div class="appbar-row">
        ${back ? `<a class="iconbtn" data-link href="${esc(back)}" aria-label="Back">${BACK_SVG}</a>` : ''}
        <div class="grow">
          <h1>${esc(title)}</h1>
          ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        </div>
        ${actions}
      </div>
      ${progress ? `
        <div class="progress-wrap">
          <div class="progress-meta">
            <span><strong>${progress.done}</strong> of ${progress.total} done</span>
            <span>${progress.flagged ? `⚑ ${progress.flagged} flagged` : `${progress.percent}%`}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${progress.percent}%"></div></div>
        </div>` : ''}
    </header>`;
}

const menuButton = `<button class="iconbtn" data-menu aria-label="Menu">${MENU_SVG}</button>`;

function wireMenu(root) {
  root.querySelector('[data-menu]')?.addEventListener('click', () => {
    const user = state.boot.user;
    openSheet(
      `<h2>${esc(user.name)}</h2>
       <p class="muted small" style="margin:2px 0 14px;">${esc(user.email)} · ${esc(user.role)}</p>
       <div class="stack">
         <a class="btn secondary block" data-link href="/">Today's shift</a>
         <a class="btn secondary block" data-link href="/history">Shift history</a>
         ${user.role === 'admin' ? `<a class="btn secondary block" data-link href="/settings">Team &amp; settings</a>` : ''}
         <button class="btn secondary block" data-password>Change password</button>
         <button class="btn danger block" data-logout>Sign out</button>
       </div>`,
      (sheet, close) => {
        sheet.addEventListener('click', (event) => {
          if (event.target.closest('a[data-link]')) close();
        });
        sheet.querySelector('[data-password]').addEventListener('click', () => { close(); passwordSheet(); });
        sheet.querySelector('[data-logout]').addEventListener('click', async () => {
          await api('/auth/logout', { method: 'POST' }).catch(() => {});
          state.boot = null;
          state.detail = null;
          close();
          history.replaceState({}, '', '/');
          renderLogin();
        });
      }
    );
  });
}

/* -------------------------------- login ------------------------------ */

function renderLogin(message = '') {
  stopPolling();
  appEl.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <div class="login-brand">
          <img src="/icon.svg" alt="">
          <h1>Captain's Log</h1>
          <p>Sign in to run your shift</p>
        </div>
        <div class="stack">
          ${message ? `<div class="error-box" id="login-error">${esc(message)}</div>` : `<div class="error-box" id="login-error" hidden></div>`}
          <div class="field">
            <label for="email">Email</label>
            <input class="input" id="email" name="email" type="email" autocomplete="username"
                   inputmode="email" autocapitalize="none" spellcheck="false" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input class="input" id="password" name="password" type="password"
                   autocomplete="current-password" required>
          </div>
          <button class="btn block" type="submit">Sign in</button>
        </div>
      </form>
    </div>`;

  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Signing in…';
    errorBox.hidden = true;

    try {
      await api('/auth/login', {
        method: 'POST',
        body: { email: form.email.value, password: form.password.value },
      });
      state.boot = await api('/bootstrap');
      route();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}

/* ------------------------- forced password change -------------------- */

function renderPasswordChange() {
  appEl.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="pw-form">
        <div class="login-brand">
          <h1>Set your password</h1>
          <p>Pick something only you know before you start.</p>
        </div>
        <div class="stack">
          <div class="error-box" id="pw-error" hidden></div>
          <div class="field">
            <label for="current">Temporary password</label>
            <input class="input" id="current" type="password" autocomplete="current-password" required>
          </div>
          <div class="field">
            <label for="next">New password</label>
            <input class="input" id="next" type="password" autocomplete="new-password" minlength="8" required>
          </div>
          <button class="btn block" type="submit">Save and continue</button>
        </div>
      </form>
    </div>`;

  const form = document.getElementById('pw-form');
  const errorBox = document.getElementById('pw-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { currentPassword: form.current.value, newPassword: form.next.value },
      });
      state.boot = await api('/bootstrap');
      toast('Password set.');
      route();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  });
}

function passwordSheet() {
  openSheet(
    `<h2>Change password</h2>
     <div class="stack" style="margin-top:12px;">
       <div class="error-box" data-error hidden></div>
       <div class="field"><label>Current password</label><input class="input" type="password" data-current autocomplete="current-password"></div>
       <div class="field"><label>New password</label><input class="input" type="password" data-next autocomplete="new-password"></div>
       <div class="row">
         <button class="btn secondary grow" data-close>Cancel</button>
         <button class="btn grow" data-save>Save</button>
       </div>
       <p class="tiny muted center" style="margin:0;">Saving signs you out on other devices.</p>
     </div>`,
    (sheet, close) => {
      const errorBox = sheet.querySelector('[data-error]');
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        errorBox.hidden = true;
        try {
          await api('/auth/password', {
            method: 'POST',
            body: {
              currentPassword: sheet.querySelector('[data-current]').value,
              newPassword: sheet.querySelector('[data-next]').value,
            },
          });
          close();
          toast('Password changed.');
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.hidden = false;
        }
      });
    }
  );
}

/* -------------------------------- home ------------------------------- */

function renderHome() {
  const { user, locations, shiftTypes, today, brandName } = state.boot;
  const savedLocation = localStorage.getItem('fscl.location');
  const location = locations.includes(savedLocation) ? savedLocation : locations[0];
  const savedShift = localStorage.getItem('fscl.shiftType');
  const shiftType = shiftTypes.includes(savedShift) ? savedShift : shiftTypes[0];

  appEl.innerHTML = `
    ${appbar({ title: brandName, sub: `Signed in as ${user.name}`, actions: menuButton })}
    <main class="page narrow">
      <div class="stack">
        <div class="card card-pad">
          <div class="stack">
            <div class="field">
              <label for="loc">Location</label>
              <select class="input" id="loc">
                ${locations.map((l) => `<option value="${esc(l)}"${l === location ? ' selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Shift</label>
              <div class="segmented" id="shift-seg">
                ${shiftTypes.map((s) => `<button type="button" data-shift="${esc(s)}" aria-pressed="${s === shiftType}">${esc(s)}</button>`).join('')}
              </div>
            </div>
            <div class="field">
              <label for="bdate">Business date</label>
              <input class="input" id="bdate" type="date" value="${esc(today)}" max="${esc(today)}">
            </div>
            <button class="btn block" id="start">Open the shift card</button>
          </div>
        </div>

        <div class="section-title">Recent shifts</div>
        <div class="card" id="recent"><div class="empty">Loading…</div></div>
      </div>
    </main>`;

  wireMenu(appEl);

  let chosenShift = shiftType;
  const seg = document.getElementById('shift-seg');
  seg.addEventListener('click', (event) => {
    const button = event.target.closest('[data-shift]');
    if (!button) return;
    chosenShift = button.dataset.shift;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
  });

  document.getElementById('start').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const loc = document.getElementById('loc').value;
    const businessDate = document.getElementById('bdate').value || today;

    localStorage.setItem('fscl.location', loc);
    localStorage.setItem('fscl.shiftType', chosenShift);

    try {
      const detail = await api('/shifts', {
        method: 'POST',
        body: { location: loc, shiftType: chosenShift, businessDate },
      });
      state.detail = detail;
      navigate(`/shift/${detail.shift.id}`);
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  });

  loadRecent();
}

async function loadRecent() {
  const host = document.getElementById('recent');
  if (!host) return;
  try {
    const { shifts } = await api('/shifts?limit=8');
    host.innerHTML = shifts.length
      ? shifts.map(shiftRow).join('')
      : `<div class="empty">No shifts logged yet. Open one above to start.</div>`;
    host.addEventListener('click', (event) => {
      const row = event.target.closest('[data-shift-id]');
      if (row) navigate(`/shift/${row.dataset.shiftId}`);
    });
  } catch (error) {
    host.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function shiftRow(shift) {
  return `
    <button class="rowitem" data-shift-id="${shift.id}">
      ${ringHtml(shift.percent)}
      <span class="grow">
        <span style="display:block;font-weight:600;">${esc(shift.location)} · ${esc(shift.shiftType)}</span>
        <span class="small muted">${esc(shift.businessDateLabel)}</span>
      </span>
      <span class="row" style="gap:6px;">
        ${shift.flagged ? `<span class="pill flag">⚑ ${shift.flagged}</span>` : ''}
        <span class="pill ${shift.status}">${shift.status === 'open' ? 'Open' : 'Closed'}</span>
      </span>
    </button>`;
}

function ringHtml(percent) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
  return `
    <span class="ring">
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="${radius}" fill="none" stroke="var(--line)" stroke-width="4"></circle>
        <circle cx="22" cy="22" r="${radius}" fill="none" stroke="var(--navy)" stroke-width="4"
                stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}"
                stroke-dashoffset="${offset.toFixed(1)}"></circle>
      </svg>
      ${percent}%
    </span>`;
}

/* ---------------------------- the shift card -------------------------- */


async function renderShift(id) {
  if (state.detail?.shift.id !== id) {
    appEl.innerHTML = `<div class="boot">Loading shift…</div>`;
    try {
      state.detail = await api(`/shifts/${id}`);
    } catch (error) {
      appEl.innerHTML = `
        ${appbar({ title: 'Shift', back: '/' })}
        <main class="page"><div class="card"><div class="empty">${esc(error.message)}</div></div></main>`;
      return;
    }
  }
  paintShift();
  startPolling(id);
}

function paintShift() {
  const { shift, sections, progress, events } = state.detail;
  const isOpen = shift.status === 'open';
  const isManager = state.boot.user.role !== 'staff';

  appEl.innerHTML = `
    ${appbar({
      title: `${shift.location} · ${shift.shiftType}`,
      sub: shift.businessDateLabel,
      back: '/',
      actions: menuButton,
      progress,
    })}
    <main class="page">
      ${!isOpen ? `
        <div class="card card-pad" style="margin-bottom:12px;">
          <div class="spread">
            <div>
              <strong>Shift closed</strong>
              <div class="small muted">${esc(shift.closedBy || '')}${shift.closedAtLabel ? ` at ${esc(shift.closedAtLabel)}` : ''}${shift.recapSentAt ? ' · recap sent' : ''}</div>
            </div>
            ${isManager ? `<button class="btn secondary small" data-reopen>Reopen</button>` : ''}
          </div>
        </div>` : ''}

      <div class="stack">
        ${sections.map(phaseHtml).join('')}
      </div>

      <div class="section-title">Shift summary</div>
      <div class="card card-pad">
        <textarea class="input" id="summary" rows="3" ${isOpen ? '' : 'disabled'}
          placeholder="Sales, labor, 86s, anything the next manager needs to know.">${esc(shift.summary)}</textarea>
        ${isOpen ? `<button class="btn secondary small" id="save-summary" style="margin-top:10px;">Save summary</button>` : ''}
      </div>

      <div class="section-title">Running log</div>
      <div class="card">
        ${isOpen ? `
          <div class="card-pad" style="border-bottom:1px solid var(--line);">
            <div class="row">
              <input class="input grow" id="log-text" placeholder="Add a note to the log…" maxlength="2000">
              <button class="btn small" id="log-add">Add</button>
            </div>
          </div>` : ''}
        ${events.length
          ? events.map(logHtml).join('')
          : `<div class="empty">Nothing logged yet.</div>`}
      </div>
    </main>

    <div class="bottombar">
      ${isOpen
        ? (isManager
            ? `<button class="btn secondary" data-recap-preview>Preview recap</button>
               <button class="btn" data-close-shift>Close &amp; send recap</button>`
            : `<button class="btn secondary block" data-recap-preview>Preview recap</button>`)
        : `<button class="btn secondary" data-recap-preview>View recap</button>
           ${isManager ? `<button class="btn" data-send-recap>Email recap</button>` : ''}`}
    </div>`;

  wireMenu(appEl);
  wireShift();
}

function phaseHtml(section) {
  const open = !state.collapsed.has(section.key);
  return `
    <section class="phase" data-open="${open}" data-phase="${esc(section.key)}">
      <button class="phase-head" data-toggle aria-expanded="${open}">
        <span class="chev"></span>
        <span class="name">${esc(section.title)}</span>
        <span class="phase-count${section.complete ? ' done' : ''}">${section.done}/${section.total}</span>
      </button>
      <div class="phase-body">
        ${section.deckWalk ? `
          <div class="deckwalk">
            <span class="badge">${section.deckWalk.number}</span>
            <span>${esc(section.deckWalk.title)}</span>
          </div>` : ''}
        ${section.blurb ? `<div class="phase-blurb">${esc(section.blurb)}</div>` : ''}
        ${section.items.map(itemHtml).join('')}
      </div>
    </section>`;
}

function itemHtml(item) {
  return `
    <div class="item${item.flagged ? ' is-flagged' : ''}" data-item="${esc(item.key)}" data-state="${item.state}">
      <button class="tick" data-tick aria-label="Toggle ${esc(item.label)}" aria-pressed="${item.state === 'done'}">
        ${item.state === 'na' ? DASH_SVG : CHECK_SVG}
      </button>
      <div class="item-main">
        <span class="item-label" data-tick>${esc(item.label)}</span>
        <div class="stamp">${item.checkedBy ? `
            <span class="who">${esc(item.checkedBy)}</span>
            <span>·</span>
            <span>${esc(item.checkedAtLabel)}</span>
            ${item.state === 'na' ? `<span class="pill">N/A</span>` : ''}` : ''}
        </div>
        ${item.note ? `<div class="note">${esc(item.note)}</div>` : ''}
      </div>
      <div class="item-actions">
        <button class="mini${item.note ? ' has' : ''}" data-note
          aria-label="${item.note ? 'Edit note' : 'Add note'}">${NOTE_SVG}</button>
        <button class="mini${item.flagged ? ' on' : ''}" data-flag aria-pressed="${item.flagged}"
          aria-label="${item.flagged ? 'Clear flag' : 'Flag for attention'}">${FLAG_SVG}</button>
      </div>
    </div>`;
}

function logHtml(event) {
  return `
    <div class="logline kind-${esc(event.type)}">
      <span class="at">${esc(event.timeLabel)}</span>
      <span class="what"><span class="who">${esc(event.user)}</span> ${esc(describeEvent(event))}</span>
    </div>`;
}

function describeEvent(event) {
  switch (event.type) {
    case 'shift_opened': return 'opened the shift';
    case 'shift_closed': return 'closed the shift';
    case 'shift_reopened': return 'reopened the shift';
    case 'item_done': return `checked off “${event.itemLabel}”`;
    case 'item_na': return `marked “${event.itemLabel}” N/A`;
    case 'item_reopened': return `unchecked “${event.itemLabel}”`;
    case 'note_added': return `noted on “${event.itemLabel}”: ${event.detail}`;
    case 'note_cleared': return `cleared the note on “${event.itemLabel}”`;
    case 'flag_raised': return `flagged “${event.itemLabel}”`;
    case 'flag_cleared': return `cleared the flag on “${event.itemLabel}”`;
    case 'log_entry': return event.detail;
    case 'summary_updated': return 'updated the shift summary';
    case 'recap_sent': return `emailed the recap to ${event.detail}`;
    default: return event.detail || event.type;
  }
}

/* ------------------------- shift screen wiring ------------------------ */

/**
 * Delegated handlers, bound ONCE to a root that outlives every repaint.
 * Binding these inside paintShift() would stack a fresh copy on each repaint,
 * so a single tap would fire as many times as the screen had been redrawn.
 */
function initShiftDelegation() {
  const onShiftScreen = () => Boolean(state.detail) && appEl.querySelector('.phase');
  const shiftIsOpen = () => state.detail?.shift.status === 'open';

  // Collapse / expand a phase.
  appEl.addEventListener('click', (event) => {
    const head = event.target.closest('[data-toggle]');
    if (!head || !onShiftScreen()) return;
    const phase = head.closest('.phase');
    const key = phase.dataset.phase;
    const nowOpen = phase.dataset.open !== 'true';
    phase.dataset.open = String(nowOpen);
    head.setAttribute('aria-expanded', String(nowOpen));
    if (nowOpen) state.collapsed.delete(key);
    else state.collapsed.add(key);
    localStorage.setItem('fscl.collapsed', JSON.stringify([...state.collapsed]));
  });

  // Set when a long-press opens the menu, so the click on release is ignored.
  let swallowNextClick = false;

  // Tick, flag, note.
  appEl.addEventListener('click', async (event) => {
    const row = event.target.closest('.item');
    if (!row || !onShiftScreen() || !shiftIsOpen()) return;
    if (swallowNextClick) { swallowNextClick = false; return; }
    const shiftId = state.detail.shift.id;
    const itemKey = row.dataset.item;

    if (event.target.closest('[data-tick]')) {
      const next = row.dataset.state === 'open' ? 'done' : 'open';
      buzz();
      await mutate(`/shifts/${shiftId}/items/${itemKey}/state`, { state: next });
      return;
    }
    if (event.target.closest('[data-flag]')) {
      buzz();
      await mutate(`/shifts/${shiftId}/items/${itemKey}/flag`, { flagged: !row.classList.contains('is-flagged') });
      return;
    }
    if (event.target.closest('[data-note]')) {
      noteSheet(itemKey);
    }
  });

  // Long-press an item for the fuller menu (N/A, clear, note, flag).
  let pressTimer = null;
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

  appEl.addEventListener('pointerdown', (event) => {
    const row = event.target.closest('.item');
    if (!row || event.target.closest('.item-actions')) return;
    if (!onShiftScreen() || !shiftIsOpen()) return;
    const itemKey = row.dataset.item;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      swallowNextClick = true;
      buzz(16);
      itemMenu(itemKey);
    }, 550);
  });

  for (const type of ['pointerup', 'pointercancel', 'pointermove']) {
    appEl.addEventListener(type, cancelPress, { passive: true });
  }
  window.addEventListener('scroll', cancelPress, { passive: true });
}

/** Per-paint wiring: every element here is recreated by paintShift(). */
function wireShift() {
  const { shift } = state.detail;
  const isOpen = shift.status === 'open';

  if (isOpen) {
    document.getElementById('save-summary')?.addEventListener('click', async () => {
      await mutate(`/shifts/${shift.id}/summary`, { summary: document.getElementById('summary').value });
      toast('Summary saved.');
    });

    const logInput = document.getElementById('log-text');
    const addLog = async () => {
      const text = logInput.value.trim();
      if (!text) return;
      logInput.value = '';
      await mutate(`/shifts/${shift.id}/log`, { text });
    };
    document.getElementById('log-add')?.addEventListener('click', addLog);
    logInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addLog(); }
    });
  }

  appEl.querySelector('[data-reopen]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({
      title: 'Reopen this shift?',
      body: 'Staff will be able to change the card again.',
      confirmLabel: 'Reopen',
    }))) return;
    await mutate(`/shifts/${shift.id}/reopen`, {});
    toast('Shift reopened.');
  });

  document.querySelector('[data-recap-preview]')?.addEventListener('click', () => {
    window.open(`/api/shifts/${shift.id}/recap.html`, '_blank', 'noopener');
  });

  document.querySelector('[data-close-shift]')?.addEventListener('click', () => closeShiftSheet());
  document.querySelector('[data-send-recap]')?.addEventListener('click', () => recapSheet());
}

/** POST, then repaint from whatever the server says is true. */
async function mutate(path, body) {
  try {
    state.detail = await api(path, { method: 'POST', body });
    paintShift();
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

function findItem(itemKey) {
  for (const section of state.detail.sections) {
    const found = section.items.find((item) => item.key === itemKey);
    if (found) return found;
  }
  return null;
}

function noteSheet(itemKey) {
  const item = findItem(itemKey);
  if (!item) return;

  openSheet(
    `<h2>Note</h2>
     <p class="muted small" style="margin:2px 0 12px;">${esc(item.label)}</p>
     <textarea class="input" data-note-text rows="4" maxlength="2000"
       placeholder="What happened? What needs following up?">${esc(item.note)}</textarea>
     <div class="row" style="margin-top:14px;">
       <button class="btn secondary grow" data-close>Cancel</button>
       <button class="btn grow" data-save>Save note</button>
     </div>`,
    (sheet, close) => {
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const note = sheet.querySelector('[data-note-text]').value;
        close();
        await mutate(`/shifts/${state.detail.shift.id}/items/${itemKey}/note`, { note });
        toast(note.trim() ? 'Note saved.' : 'Note cleared.');
      });
    }
  );
}

function itemMenu(itemKey) {
  const item = findItem(itemKey);
  if (!item) return;
  const shiftId = state.detail.shift.id;

  openSheet(
    `<h2 style="font-size:16px;">${esc(item.label)}</h2>
     <div class="stack" style="margin-top:14px;">
       <button class="btn secondary block" data-state="done">Mark done</button>
       <button class="btn secondary block" data-state="na">Mark N/A (not applicable)</button>
       <button class="btn secondary block" data-state="open">Clear / uncheck</button>
       <button class="btn secondary block" data-do-note>${item.note ? 'Edit note' : 'Add a note'}</button>
       <button class="btn secondary block" data-do-flag>${item.flagged ? 'Clear flag' : 'Flag for attention'}</button>
       <button class="btn ghost block" data-close>Cancel</button>
     </div>`,
    (sheet, close) => {
      sheet.addEventListener('click', async (event) => {
        const stateButton = event.target.closest('[data-state]');
        if (stateButton) {
          close();
          await mutate(`/shifts/${shiftId}/items/${itemKey}/state`, { state: stateButton.dataset.state });
          return;
        }
        if (event.target.closest('[data-do-note]')) { close(); noteSheet(itemKey); return; }
        if (event.target.closest('[data-do-flag]')) {
          close();
          await mutate(`/shifts/${shiftId}/items/${itemKey}/flag`, { flagged: !item.flagged });
        }
      });
    }
  );
}

/* --------------------------- close & recap --------------------------- */

function recipientsField(label = 'Send recap to') {
  const defaults = (state.boot.defaultRecipients || []).join(', ');
  return `
    <div class="field">
      <label>${esc(label)}</label>
      <textarea class="input" data-recipients rows="2" placeholder="name@example.com, other@example.com"
        autocapitalize="none" spellcheck="false">${esc(defaults)}</textarea>
      <span class="tiny muted">Separate addresses with commas.${state.boot.emailEnabled ? '' : ' Email is not configured on this server yet.'}</span>
    </div>`;
}

function closeShiftSheet() {
  const { shift, progress } = state.detail;
  const remaining = progress.total - progress.done;

  openSheet(
    `<h2>Close the shift</h2>
     <p class="muted small" style="margin:2px 0 14px;">
       ${remaining
         ? `${remaining} item${remaining === 1 ? '' : 's'} still unchecked — they'll be listed in the recap as not completed.`
         : 'Every item is accounted for.'}
     </p>
     <div class="stack">
       <div class="error-box" data-error hidden></div>
       <div class="field">
         <label>Shift summary</label>
         <textarea class="input" data-summary rows="3"
           placeholder="Sales, labor, 86s, open issues.">${esc(shift.summary)}</textarea>
       </div>
       <label class="row" style="gap:10px;cursor:pointer;">
         <input type="checkbox" data-send ${state.boot.emailEnabled ? 'checked' : 'disabled'}
                style="width:22px;height:22px;flex:none;">
         <span class="grow small">Email the recap when I close</span>
       </label>
       <div data-recipients-wrap>${recipientsField()}</div>
       <div class="row">
         <button class="btn secondary grow" data-close>Cancel</button>
         <button class="btn grow" data-go>Close shift</button>
       </div>
     </div>`,
    (sheet, close) => {
      const sendBox = sheet.querySelector('[data-send]');
      const wrap = sheet.querySelector('[data-recipients-wrap]');
      const errorBox = sheet.querySelector('[data-error]');
      const sync = () => { wrap.hidden = !sendBox.checked; };
      sendBox.addEventListener('change', sync);
      sync();

      sheet.querySelector('[data-go]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Closing…';
        errorBox.hidden = true;

        try {
          const payload = {
            summary: sheet.querySelector('[data-summary]').value,
            sendRecap: sendBox.checked,
          };
          if (sendBox.checked) payload.recipients = sheet.querySelector('[data-recipients]').value;

          state.detail = await api(`/shifts/${state.detail.shift.id}/close`, { method: 'POST', body: payload });
          close();
          paintShift();
          toast(state.detail.email?.sent ? 'Shift closed and recap sent.' : 'Shift closed.');
        } catch (error) {
          // The shift may have closed even if the email bounced; refresh either way.
          errorBox.textContent = error.message;
          errorBox.hidden = false;
          button.disabled = false;
          button.textContent = 'Close shift';
          try {
            state.detail = await api(`/shifts/${state.detail.shift.id}`);
          } catch { /* keep what we have */ }
        }
      });
    }
  );
}

function recapSheet() {
  openSheet(
    `<h2>Email the recap</h2>
     <div class="stack" style="margin-top:12px;">
       <div class="error-box" data-error hidden></div>
       ${recipientsField('Recipients')}
       <div class="row">
         <button class="btn secondary grow" data-close>Cancel</button>
         <button class="btn grow" data-go>Send</button>
       </div>
     </div>`,
    (sheet, close) => {
      const errorBox = sheet.querySelector('[data-error]');
      sheet.querySelector('[data-go]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Sending…';
        errorBox.hidden = true;
        try {
          state.detail = await api(`/shifts/${state.detail.shift.id}/recap/email`, {
            method: 'POST',
            body: { recipients: sheet.querySelector('[data-recipients]').value },
          });
          close();
          paintShift();
          toast(`Recap sent to ${state.detail.email.recipients.length} recipient(s).`);
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.hidden = false;
          button.disabled = false;
          button.textContent = 'Send';
        }
      });
    }
  );
}

/* ------------------------------- history ------------------------------ */

async function renderHistory() {
  const { locations } = state.boot;
  appEl.innerHTML = `
    ${appbar({ title: 'Shift history', back: '/', actions: menuButton })}
    <main class="page">
      <div class="card card-pad" style="margin-bottom:12px;">
        <div class="row wrap">
          <div class="field grow">
            <label for="h-loc">Location</label>
            <select class="input" id="h-loc">
              <option value="">All locations</option>
              ${locations.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="field grow">
            <label for="h-from">From</label>
            <input class="input" id="h-from" type="date">
          </div>
          <div class="field grow">
            <label for="h-to">To</label>
            <input class="input" id="h-to" type="date">
          </div>
        </div>
      </div>
      <div class="card" id="history-list"><div class="empty">Loading…</div></div>
    </main>`;

  wireMenu(appEl);

  const host = document.getElementById('history-list');
  const load = async () => {
    host.innerHTML = `<div class="empty">Loading…</div>`;
    const params = new URLSearchParams();
    const location = document.getElementById('h-loc').value;
    const from = document.getElementById('h-from').value;
    const to = document.getElementById('h-to').value;
    if (location) params.set('location', location);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', '100');

    try {
      const { shifts } = await api(`/shifts?${params}`);
      host.innerHTML = shifts.length
        ? shifts.map(shiftRow).join('')
        : `<div class="empty">No shifts match those filters.</div>`;
    } catch (error) {
      host.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  };

  for (const id of ['h-loc', 'h-from', 'h-to']) {
    document.getElementById(id).addEventListener('change', load);
  }

  host.addEventListener('click', (event) => {
    const row = event.target.closest('[data-shift-id]');
    if (row) navigate(`/shift/${row.dataset.shiftId}`);
  });

  load();
}

/* ------------------------------ settings ------------------------------ */

async function renderSettings() {
  if (state.boot.user.role !== 'admin') return navigate('/', true);

  appEl.innerHTML = `
    ${appbar({ title: 'Team & settings', back: '/', actions: menuButton })}
    <main class="page">
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected="true" data-tab="team">Team</button>
        <button role="tab" aria-selected="false" data-tab="shop">Shop</button>
      </div>
      <div id="tab-body"><div class="empty">Loading…</div></div>
    </main>`;

  wireMenu(appEl);

  const body = document.getElementById('tab-body');
  const tabs = appEl.querySelector('.tabs');

  const show = async (tab) => {
    for (const button of tabs.querySelectorAll('button')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    body.innerHTML = `<div class="empty">Loading…</div>`;
    if (tab === 'team') await renderTeamTab(body);
    else await renderShopTab(body);
  };

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) show(button.dataset.tab);
  });

  show('team');
}

async function renderTeamTab(host) {
  let users = [];
  try {
    ({ users } = await api('/admin/users'));
  } catch (error) {
    host.innerHTML = `<div class="card"><div class="empty">${esc(error.message)}</div></div>`;
    return;
  }

  host.innerHTML = `
    <button class="btn block" id="add-user" style="margin-bottom:12px;">Add a team member</button>
    <div class="card">
      ${users.map((user) => `
        <button class="rowitem" data-user="${user.id}">
          <span class="grow">
            <span style="display:block;font-weight:600;">${esc(user.name)}${user.active ? '' : ' <span class="muted">(inactive)</span>'}</span>
            <span class="small muted">${esc(user.email)}</span>
          </span>
          <span class="pill">${esc(user.role)}</span>
        </button>`).join('')}
    </div>
    <p class="tiny muted" style="padding:10px 4px;">
      Staff can run the card. Managers can also close shifts, reopen them and send recaps. Admins manage the team.
    </p>`;

  document.getElementById('add-user').addEventListener('click', () => userSheet(null, host));
  host.addEventListener('click', (event) => {
    const row = event.target.closest('[data-user]');
    if (row) userSheet(users.find((u) => u.id === Number(row.dataset.user)), host);
  });
}

function userSheet(user, host) {
  const editing = Boolean(user);

  openSheet(
    `<h2>${editing ? esc(user.name) : 'Add a team member'}</h2>
     <div class="stack" style="margin-top:12px;">
       <div class="error-box" data-error hidden></div>
       <div class="field"><label>Name</label><input class="input" data-name value="${editing ? esc(user.name) : ''}"></div>
       ${editing
         ? `<div class="field"><label>Email</label><input class="input" value="${esc(user.email)}" disabled></div>`
         : `<div class="field"><label>Email</label><input class="input" data-email type="email" inputmode="email"
              autocapitalize="none" spellcheck="false"></div>`}
       <div class="field">
         <label>Role</label>
         <select class="input" data-role>
           ${['staff', 'manager', 'admin'].map((role) =>
             `<option value="${role}"${editing && user.role === role ? ' selected' : ''}>${role}</option>`).join('')}
         </select>
       </div>
       <div class="field">
         <label>${editing ? 'Reset password to' : 'Temporary password'}</label>
         <input class="input" data-password type="text" autocapitalize="none" spellcheck="false"
                placeholder="${editing ? 'Leave blank to keep current' : 'At least 8 characters'}">
         <span class="tiny muted">They'll be asked to choose their own on first sign-in.</span>
       </div>
       ${editing ? `
         <label class="row" style="gap:10px;cursor:pointer;">
           <input type="checkbox" data-active ${user.active ? 'checked' : ''} style="width:22px;height:22px;flex:none;">
           <span class="grow small">Active — can sign in</span>
         </label>` : ''}
       <div class="row">
         <button class="btn secondary grow" data-close>Cancel</button>
         <button class="btn grow" data-save>${editing ? 'Save changes' : 'Create'}</button>
       </div>
     </div>`,
    (sheet, close) => {
      const errorBox = sheet.querySelector('[data-error]');
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        errorBox.hidden = true;
        const name = sheet.querySelector('[data-name]').value.trim();
        const role = sheet.querySelector('[data-role]').value;
        const password = sheet.querySelector('[data-password]').value;

        try {
          if (editing) {
            const body = { name, role, active: sheet.querySelector('[data-active]').checked };
            if (password) body.password = password;
            await api(`/admin/users/${user.id}`, { method: 'PATCH', body });
            toast('Saved.');
          } else {
            await api('/admin/users', {
              method: 'POST',
              body: { name, role, password, email: sheet.querySelector('[data-email]').value },
            });
            toast('Team member added.');
          }
          close();
          renderTeamTab(host);
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.hidden = false;
        }
      });
    }
  );
}

async function renderShopTab(host) {
  let settings;
  try {
    settings = await api('/admin/settings');
  } catch (error) {
    host.innerHTML = `<div class="card"><div class="empty">${esc(error.message)}</div></div>`;
    return;
  }

  host.innerHTML = `
    <div class="card card-pad">
      <div class="stack">
        <div class="error-box" id="shop-error" hidden></div>
        <div class="field">
          <label>Locations</label>
          <textarea class="input" id="s-locations" rows="3">${esc(settings.locations.join('\n'))}</textarea>
          <span class="tiny muted">One per line.</span>
        </div>
        <div class="field">
          <label>Shift types</label>
          <textarea class="input" id="s-shifts" rows="2">${esc(settings.shiftTypes.join('\n'))}</textarea>
          <span class="tiny muted">One per line — AM, PM, Mid, whatever you run.</span>
        </div>
        <div class="field">
          <label>Default recap recipients</label>
          <textarea class="input" id="s-recipients" rows="3"
            autocapitalize="none" spellcheck="false">${esc(settings.recapRecipients.join('\n'))}</textarea>
          <span class="tiny muted">These are pre-filled whenever a manager sends a recap.</span>
        </div>
        <button class="btn block" id="s-save">Save settings</button>
        <button class="btn secondary block" id="s-test">Test the email connection</button>
      </div>
    </div>`;

  const errorBox = document.getElementById('shop-error');
  const lines = (id) => document.getElementById(id).value.split('\n').map((v) => v.trim()).filter(Boolean);

  document.getElementById('s-save').addEventListener('click', async () => {
    errorBox.hidden = true;
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: {
          locations: lines('s-locations'),
          shiftTypes: lines('s-shifts'),
          recapRecipients: lines('s-recipients'),
        },
      });
      state.boot = await api('/bootstrap');
      toast('Settings saved.');
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  });

  document.getElementById('s-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const result = await api('/admin/email/test', { method: 'POST' });
      toast(result.ok ? 'Email connection works.' : `Email problem: ${result.reason}`, !result.ok);
    } catch (error) {
      toast(error.message, true);
    }
    button.disabled = false;
    button.textContent = 'Test the email connection';
  });
}

/* -------------------------------- start ------------------------------- */

initShiftDelegation();
route();
