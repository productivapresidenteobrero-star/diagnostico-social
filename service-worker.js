// Service Worker - Diagnostico Social Comunitario
// Version: 1.0.2

const CACHE_NAME = 'diagsocial-v1.0.2';
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
  console.log('[SW] Instalando Service Worker v1.0.2...');
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

// Fetch: Network-First para index.html (SIEMPRE actualizado), Cache-First para el resto
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // No interceptar peticiones a Google Apps Script
  if (url.href.includes('script.google.com')) {
    return;
  }

  // Para index.html y navegacion: Network-First (trae version nueva si hay internet)
  if (request.mode === 'navigate' || (request.destination === 'document' && url.pathname.endsWith('index.html'))) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(request).then((cachedResponse) => {
            return cachedResponse || caches.match(BASE_PATH + '/index.html');
          });
        })
    );
    return;
  }

  // Para recursos estaticos (CSS, JS, manifest): Cache-First
  if (request.destination === 'style' || request.destination === 'script' || request.destination === 'manifest') {
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

// Mensajes desde la app principal
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});