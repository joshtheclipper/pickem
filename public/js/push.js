// Client helpers for the Account page notification toggles.
// Depends on api.js (loaded first) for the api.* fetch wrappers.

const pushClient = {
  // Feature-detects everything the browser needs for Web Push. iOS only
  // exposes this once the site is installed to the Home Screen.
  supported() {
    return (
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  },

  async _registration() {
    return navigator.serviceWorker.register('/sw.js');
  },

  async currentSubscription() {
    if (!this.supported()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  },

  // Runs the full opt-in: permission prompt -> service worker -> push
  // subscription -> hand it to the server along with the opt-in `flags` to
  // set, e.g. { notify_kickoff: true }. Returns { ok: true } or
  // { ok: false, reason }.
  async enable(publicKey, flags) {
    if (!this.supported()) return { ok: false, reason: 'unsupported' };

    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: permission };

    const reg = await this._registration();
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await api.post('/api/push/subscribe', { subscription: sub, ...flags });
    return { ok: true };
  },

  // Tears every opt-in back down. Best-effort: even if unsubscribing the
  // browser fails, the server flags still get cleared.
  async disable() {
    let endpoint;
    try {
      const sub = await this.currentSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    } catch (e) {
      /* fall through — still clear the server flag */
    }
    await api.post('/api/push/unsubscribe', { endpoint });
    return { ok: true };
  },
};

// VAPID public keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
