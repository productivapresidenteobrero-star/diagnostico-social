// Service Worker - Diagnostico Social Comunitario
// Version: 1.0.1

const CACHE_NAME = 'diagsocial-v1';
const BASE_PATH = '/diagnostico-social';
const STATIC_ASSETS = [
  BASE_PATH + '/',
  BASE_PATH + '/index.html',
  BASE_PATH + '/styles.css',
  BASE_PATH + '/app.js',
  BASE_PATH + '/manifest.json'
];

// Instalacion: cachear recursos estaticos
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando Service Worker...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Cacheando recursos estaticos...');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activacion: limpiar caches antiguas
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

// Fetch: estrategia Cache-First para recursos estaticos
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // No interceptar peticiones a Google Apps Script
  if (url.href.includes('script.google.com')) {
    return;
  }

  // Para recursos estaticos: Cache-First
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
          // Si falla la red y no hay cache, mostrar pagina offline
          if (request.mode === 'navigate') {
            return caches.match(BASE_PATH + '/index.html');
          }
        });
      })
    );
  }
});

// Sincronizacion en background
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-encuestas') {
    console.log('[SW] Sincronizacion en background activada');
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SYNC_TRIGGERED' });
        });
      })
    );
  }
});

// Notificaciones push
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || 'Sincronizacion completada',
    icon: BASE_PATH + '/icon-192.png',
    badge: BASE_PATH + '/icon-192.png',
    tag: 'sync-notification',
    requireInteraction: false
  };
  event.waitUntil(
    self.registration.showNotification('Diagnostico Social', options)
  );
});

// Mensajes desde la app principal
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
