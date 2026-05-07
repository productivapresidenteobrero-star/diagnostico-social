// ============================================
// SERVICE WORKER - Diagnostico Social v2.0.0
// Offline-first caching strategy
// ============================================

const CACHE_NAME = 'diagnostico-social-v2.0.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  console.log('[SW] Instalando v2.0.0...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW] Error cache:', err))
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activando v2.0.0...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // No interceptar Google Apps Script (siempre online)
  if (url.hostname.includes('google.com') || url.hostname.includes('googleusercontent.com')) {
    return;
  }

  // Estrategia: Cache First para assets locales, Network First para APIs
  if (STATIC_ASSETS.some(asset => url.pathname.endsWith(asset.replace('./', '/')) || 
      url.pathname === '/' || url.pathname === '')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
            return response;
          });
        });
      }).catch(() => {
        // Fallback para navegacion
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      })
    );
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-encuestas') {
    console.log('[SW] Background sync triggered');
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_REQUEST' }));
      })
    );
  }
});