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
  try {
    const { user } = await api.get('/api/auth/me');
    return user;
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
}

function currentSeasonYear() {
  return new Date().getFullYear();
}

// A reasonable default week estimate (NFL/NCAAF regular seasons start early Sept).
// Admin/users can still navigate to any week manually.
function estimateCurrentWeek() {
  const now = new Date();
  const seasonStart = new Date(now.getFullYear(), 8, 1); // Sept 1
  if (now < seasonStart) return 1;
  const diffDays = Math.floor((now - seasonStart) / 86400000);
  return Math.max(1, Math.min(18, Math.floor(diffDays / 7) + 1));
}
