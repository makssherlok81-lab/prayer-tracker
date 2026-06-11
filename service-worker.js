importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBspu-SKYW74XWEqEL0-L4pFA_gEwgcvhs",
  authDomain: "prayer-tracker-6e032.firebaseapp.com",
  projectId: "prayer-tracker-6e032",
  storageBucket: "prayer-tracker-6e032.appspot.com",
  messagingSenderId: "66232408397",
  appId: "1:66232408397:web:2601743c8f222cc88fff04"
});

const messaging = firebase.messaging();

const CACHE_NAME = 'prayer-tracker-v3';
const ASSETS = [
  '/prayer-tracker/prayer-tracker.html',
  '/prayer-tracker/manifest.json',
  '/prayer-tracker/icon-192.png',
  '/prayer-tracker/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.endsWith('.html') || e.request.url.includes('firebase') || e.request.url.includes('gstatic')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});

// Handle background push notifications
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'Prayer Tracker', {
    body: body || 'Did you log your prayers today?',
    icon: '/prayer-tracker/icon-192.png',
    badge: '/prayer-tracker/icon-192.png',
    data: { url: '/prayer-tracker/prayer-tracker.html' }
  });
});

// Open app when notification is tapped
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/prayer-tracker/prayer-tracker.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('prayer-tracker') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
