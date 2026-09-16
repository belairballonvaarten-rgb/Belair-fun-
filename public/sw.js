// Service worker enkel voor push-meldingen (geen offline-cache/etc.) — vangt
// een binnenkomende push op en toont ze effectief als systeemmelding. Zonder
// dit bestand komt een push wel aan bij de browser, maar wordt er nooit iets
// getoond: 'reg.pushManager.subscribe(...)' in index.html/voertuig.html werkt
// pas zodra hier ook echt een 'push'-listener actief is.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Belair-Fun', message: event.data ? event.data.text() : '' }; }
  const titel = data.title || 'Belair-Fun';
  const opties = {
    body: data.message || '',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(titel, opties));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
