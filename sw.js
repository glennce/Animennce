/* ============================================================
   AniNexus Service Worker
   Handles: Caching, Offline Support, Push Notifications,
            Background Sync for episode checks
   ============================================================ */

'use strict';

const SW_VERSION   = 'aninexus-v1.0.0';
const CACHE_STATIC = `${SW_VERSION}-static`;
const CACHE_API    = `${SW_VERSION}-api`;

/* Files to pre-cache on install */
const STATIC_ASSETS = [
  '/index.html',
  '/upcoming.html',
  '/seasonal.html',
  '/anime.html',
  '/favorites.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/* ============================================================
   INSTALL — pre-cache static shell
   ============================================================ */
self.addEventListener('install', event => {
  console.log('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      // Use individual adds so one failure doesn't break all
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

/* ============================================================
   ACTIVATE — clean up old caches
   ============================================================ */
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ============================================================
   FETCH — Network-first for API, Cache-first for assets
   ============================================================ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // Jikan API calls → Network first, cache fallback (5min TTL)
  if (url.hostname === 'api.jikan.moe') {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // Static assets → Cache first, network fallback
  if (
    url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }
});

async function networkFirstAPI(request) {
  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      const cache = await caches.open(CACHE_API);
      // Store with timestamp header
      const headers  = new Headers(response.headers);
      headers.append('sw-cache-ts', Date.now().toString());
      const body     = await response.clone().arrayBuffer();
      const stamped  = new Response(body, { status: response.status, headers });
      cache.put(request, stamped);
    }
    return response;
  } catch {
    // Offline fallback from cache
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ data: [], error: 'offline' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return offline page for navigation requests
    if (request.mode === 'navigate') {
      const offlinePage = await caches.match('/index.html');
      if (offlinePage) return offlinePage;
    }
    return new Response('Offline', { status: 503 });
  }
}

/* ============================================================
   PUSH NOTIFICATIONS
   Receives push events from our episode-check logic
   ============================================================ */
self.addEventListener('push', event => {
  let data = { title: 'AniNexus', body: 'New anime update!', animeId: null };

  if (event.data) {
    try { data = { ...data, ...event.data.json() }; }
    catch { data.body = event.data.text(); }
  }

  const options = {
    body:    data.body,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-96.png',
    image:   data.image || undefined,
    tag:     data.animeId ? `anime-${data.animeId}` : 'aninexus-update',
    renotify: true,
    vibrate: [200, 100, 200],
    data: {
      url:     data.animeId ? `/anime.html?id=${data.animeId}` : '/index.html',
      animeId: data.animeId,
    },
    actions: [
      { action: 'view',   title: '▶ View Anime' },
      { action: 'dismiss', title: '✕ Dismiss'   },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

/* ============================================================
   NOTIFICATION CLICK — open anime page
   ============================================================ */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Focus existing tab if open
        for (const client of clientList) {
          const clientUrl = new URL(client.url);
          if (clientUrl.pathname === new URL(targetUrl, self.location.origin).pathname) {
            return client.focus();
          }
        }
        // Open new tab
        return clients.openWindow(targetUrl);
      })
  );
});

/* ============================================================
   BACKGROUND SYNC — Check watched anime for new episodes
   Triggered by main thread via: registration.sync.register('check-episodes')
   ============================================================ */
self.addEventListener('sync', event => {
  if (event.tag === 'check-episodes') {
    event.waitUntil(checkEpisodeUpdates());
  }
});

async function checkEpisodeUpdates() {
  try {
    // Read watched list from IndexedDB (written by main thread)
    const watched = await getWatchedFromIDB();
    if (!watched.length) return;

    for (const item of watched) {
      // Fetch current episode count from Jikan
      const res = await fetch(`https://api.jikan.moe/v4/anime/${item.mal_id}`);
      if (!res.ok) continue;

      const json = await res.json();
      const current = json.data?.episodes || 0;

      if (current > (item.lastKnownEpisodes || 0)) {
        // New episode(s) detected!
        await self.registration.showNotification(
          `🎌 New Episode — ${json.data.title}`,
          {
            body:    `Episode ${current} is now available!`,
            icon:    json.data.images?.jpg?.image_url || '/icons/icon-192.png',
            badge:   '/icons/icon-96.png',
            tag:     `ep-update-${item.mal_id}`,
            vibrate: [200, 100, 200],
            data: { url: `/anime.html?id=${item.mal_id}`, animeId: item.mal_id },
            actions: [
              { action: 'view', title: '▶ Watch Now' },
              { action: 'dismiss', title: '✕ Later'  },
            ],
          }
        );

        // Update stored count
        await updateWatchedEpisodeCount(item.mal_id, current);
      }
    }
  } catch (e) {
    console.error('[SW] Episode check failed:', e);
  }
}

/* ---- IndexedDB helpers (used in background sync) ---- */
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('aninexus', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('watched')) {
        db.createObjectStore('watched', { keyPath: 'mal_id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getWatchedFromIDB() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('watched', 'readonly');
    const store = tx.objectStore('watched');
    const req   = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function updateWatchedEpisodeCount(mal_id, episodes) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('watched', 'readwrite');
    const store = tx.objectStore('watched');
    const getReq = store.get(mal_id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (record) {
        record.lastKnownEpisodes = episodes;
        store.put(record);
      }
      resolve();
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/* ============================================================
   MESSAGE — receive commands from main thread
   ============================================================ */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'PING') {
    event.ports[0]?.postMessage({ type: 'PONG', version: SW_VERSION });
  }
});
