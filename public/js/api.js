const api = {
  async _req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this._req('GET', url); },
  post(url, body) { return this._req('POST', url, body); },
  del(url, body) { return this._req('DELETE', url, body); },
};

async function requireLogin() {
  let user;
  try {
    ({ user } = await api.get('/api/auth/me'));
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
  // The account's saved color mode wins over this device's cached one.
  if (window.pickemTheme && user.theme && user.theme !== window.pickemTheme.pref) {
    window.pickemTheme.set(user.theme);
  }
  return user;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A player's profile photo, or their initials when they haven't set one.
// `u` needs user_id, username and avatar_v (the photo version, null = none).
function avatarHtml(u, size = 32, extraClass = '') {
  const dim = `width:${size}px;height:${size}px`;
  if (u.avatar_v) {
    return `<img class="avatar ${extraClass}" src="/api/avatars/${u.user_id}?v=${u.avatar_v}" alt="" style="${dim}" loading="lazy">`;
  }
  const letters = (String(u.username || '?').match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar avatar-ini ${extraClass}" style="${dim};font-size:${Math.round(size * 0.36)}px" aria-hidden="true">${escapeHtml(letters)}</span>`;
}

// --- "Admin-edited" badge + timestamp popover ---
// editedAt is the raw admin_edited_at column: UTC in SQLite's
// "YYYY-MM-DD HH:MM:SS" form, or null for overrides made before the
// timestamp was tracked.
function parseDbUtc(s) {
  return s ? new Date(s.replace(' ', 'T') + 'Z') : null;
}

function formatAdminEdit(editedAt) {
  const d = parseDbUtc(editedAt);
  if (!d || isNaN(d)) return { when: 'Time not recorded', rel: '' };
  const when = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  let rel;
  if (mins < 1) rel = 'just now';
  else if (mins < 60) rel = `${mins} min ago`;
  else if (mins < 60 * 24) { const h = Math.round(mins / 60); rel = `${h} hour${h === 1 ? '' : 's'} ago`; }
  else { const days = Math.round(mins / (60 * 24)); rel = `${days} day${days === 1 ? '' : 's'} ago`; }
  return { when, rel };
}

// Tappable badge; the popover opens above it, or below it with `inline`
// (the small badge in a "Show picks" list).
function adminEditedBadgeHtml(editedAt, inline = false) {
  const { when, rel } = formatAdminEdit(editedAt);
  return `<span class="admin-edit-anchor${inline ? ' pop-below' : ''}">` +
    `<button type="button" class="admin-edited-badge${inline ? ' admin-edited-badge-inline' : ''}" aria-expanded="false">Admin-edited</button>` +
    `<span class="admin-edit-pop" hidden><span class="admin-edit-pop-k">Changed by an admin</span>` +
    `<span class="admin-edit-pop-when">${escapeHtml(when)}</span>${rel ? `<span class="admin-edit-pop-rel">${rel}</span>` : ''}</span>` +
    `</span>`;
}

// One document-level handler drives every badge, including ones rendered
// after page load. Only one popover is open at a time; tapping elsewhere or
// pressing Escape closes it.
(function () {
  function closeAll(except) {
    document.querySelectorAll('.admin-edit-anchor .admin-edited-badge[aria-expanded="true"]').forEach((b) => {
      if (b === except) return;
      b.setAttribute('aria-expanded', 'false');
      b.nextElementSibling.hidden = true;
    });
  }
  document.addEventListener('click', (e) => {
    const badge = e.target.closest('.admin-edit-anchor .admin-edited-badge');
    if (!badge) return closeAll();
    // The badge can sit inside other clickable bits of a card.
    e.stopPropagation();
    const pop = badge.nextElementSibling;
    closeAll(badge);
    pop.hidden = !pop.hidden;
    badge.setAttribute('aria-expanded', String(!pop.hidden));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
})();

function currentSeasonYear() {
  const now = new Date();
  // NFL/NCAAF seasons straddle the new year — a game played in Jan/Feb
  // (playoffs, bowls) still belongs to the season that kicked off the
  // previous August, so it keeps the earlier calendar year.
  return now.getMonth() <= 1 ? now.getFullYear() - 1 : now.getFullYear();
}

// A rough date-only week estimate, used only as a fallback when the server
// can't derive the current week from the actual schedule (e.g. no games
// entered yet). The real default comes from GET /api/games/current-week.
// Admin/users can still navigate to any week manually.
function estimateCurrentWeek() {
  const now = new Date();
  const seasonStart = new Date(currentSeasonYear(), 8, 1); // Sept 1
  if (now < seasonStart) return 1;
  const diffDays = Math.floor((now - seasonStart) / 86400000);
  return Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1));
}
