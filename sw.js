// FeniX service worker: shows push notifications also when the app is in the background or closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'FeniX', body: event.data?.text() || '' }; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.filter(c => c.visibilityState === 'visible');
    const parentPlayRequest = String(data.title || '').includes('Uusi peliaikapyyntö');
    if (visible.length && parentPlayRequest) {
      // Foreground parent gets the in-app approval popup instead of a duplicate system alert.
      visible.forEach(c => c.postMessage({ type: 'fenix-push', payload: data }));
      return;
    }
    // Child task/play-end events use a real Android notification even while FeniX is open,
    // so the phone can play its configured notification sound and vibrate.
    await self.registration.showNotification(data.title || 'FeniX', {
      body: data.body || '',
      tag: data.tag || undefined,          // Same event → same tag, so a notification is never shown twice.
      renotify: true,
      silent: false,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      vibrate: [120, 60, 120],
      data: { url: data.url || '/', kind: data.kind || '' },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = windows.find(c => new URL(c.url).pathname === url.pathname) || windows[0];
    if (same) {
      await same.focus();
      same.postMessage({ type: 'fenix-open', url: url.pathname + url.search });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
