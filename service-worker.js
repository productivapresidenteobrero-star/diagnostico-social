// Service Worker - Diagnóstico Social Comunitario
// Versión: 1.0.0

const CACHE_NAME = 'diagsocial-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json'
];

// Instalación: cachear recursos estáticos
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando Service Worker...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Cacheando recursos estáticos...');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activación: limpiar caches antiguas
self.addEventListener('activate', (event) => {
  console.log('[SW] Activando Service Worker...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Eliminando cache antigua:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch: estrategia Cache-First para recursos estáticos, Network-First para API
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // No interceptar peticiones a Google Apps Script (dejar que pasen normal)
  if (url.href.includes('script.google.com')) {
    return;
  }

  // Para recursos estáticos: Cache-First
  if (request.mode === 'navigate' || 
      request.destination === 'style' || 
      request.destination === 'script' ||
      request.destination === 'document') {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
          return networkResponse;
        }).catch(() => {
          // Si falla la red y no hay cache, mostrar página offline
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
    );
  }
});

// Sincronización en background (cuando vuelve la conexión)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-encuestas') {
    console.log('[SW] Sincronización en background activada');
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SYNC_TRIGGERED' });
        });
      })
    );
  }
});

// Notificaciones push (para sincronización completada)
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || 'Sincronización completada',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'sync-notification',
    requireInteraction: false
  };
  event.waitUntil(
    self.registration.showNotification('Diagnóstico Social', options)
  );
});

// Mensajes desde la app principal
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
