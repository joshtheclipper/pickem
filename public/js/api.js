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
