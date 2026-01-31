const CACHE_NAME = 'nedzat-v1';
const urlsToCache = [
  '/public/chat.html',
  '/public/assets/img/logo-gemini.png',
  // Добавь звуки, если они локальные
  '/public/assets/sounds/message.mp3',
  '/public/assets/sounds/sent.mp3'
];

// Install - кэшируем файлы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate - чистим старые кэши
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names.map(name => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch - стратегия Network First (для динамического контента)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

// ⭐ PUSH EVENT - Показываем уведомление
self.addEventListener('push', (event) => {
  let data = {};
  
  try {
    data = event.data ? event.data.json() : {};
  } catch(e) {
    data = { title: 'Новое сообщение', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'NeDzat';
  const options = {
    body: data.body || 'У вас новое сообщение',
    icon: data.icon || '/public/assets/img/logo-gemini-192.png',
    badge: '/public/assets/img/logo-gemini-192.png',
    tag: data.tag || 'message',
    data: data.url || '/public/chat.html',
    vibrate: [200, 100, 200],
    sound: '/public/assets/sounds/message.mp3', // ← Звук уведомления
    requireInteraction: false,
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ⭐ NOTIFICATION CLICK - Открываем чат
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data || '/public/chat.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Если окно уже открыто - фокусируемся на нём
        for (let i = 0; i < windowClients.length; i++) {
          const client = windowClients[i];
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        // Иначе открываем новое окно
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});