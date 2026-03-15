/* ============================================================
   AniNexus — PWA & Notifications Module
   Handles: SW registration, install prompt, push notifications,
            watched-list management, episode tracking, IDB ops
   ============================================================ */

'use strict';

/* ============================================================
   SERVICE WORKER REGISTRATION
   ============================================================ */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[PWA] SW registered:', reg.scope);

    // Listen for SW updates
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }
      });
    });

    return reg;
  } catch (e) {
    console.warn('[PWA] SW registration failed:', e);
  }
}

function showUpdateBanner() {
  showToast('🔄 App updated! Refresh to get the latest version.', 'info', 8000);
}

/* ============================================================
   INDEXED DB — Watched / Notification subscriptions
   ============================================================ */
const IDB_NAME    = 'aninexus';
const IDB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // Store for anime the user wants notifications for
      if (!db.objectStoreNames.contains('watched')) {
        const ws = db.createObjectStore('watched', { keyPath: 'mal_id' });
        ws.createIndex('title', 'title', { unique: false });
      }
      // Store for in-app notifications
      if (!db.objectStoreNames.contains('notifications')) {
        const ns = db.createObjectStore('notifications', {
          keyPath: 'id', autoIncrement: true
        });
        ns.createIndex('animeId', 'animeId', { unique: false });
        ns.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

/* ---- Watched list helpers ---- */
async function getWatchedList() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('watched', 'readonly');
    const req = tx.objectStore('watched').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}

async function addToWatched(anime) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const record = {
      mal_id:             anime.mal_id,
      title:              anime.title,
      image:              anime.images?.jpg?.image_url || '',
      status:             anime.status || '',
      lastKnownEpisodes:  anime.episodes || 0,
      addedAt:            Date.now(),
    };
    const tx  = db.transaction('watched', 'readwrite');
    const req = tx.objectStore('watched').put(record);
    req.onsuccess = () => res(true);
    req.onerror   = () => rej(req.error);
  });
}

async function removeFromWatched(mal_id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('watched', 'readwrite');
    const req = tx.objectStore('watched').delete(mal_id);
    req.onsuccess = () => res(true);
    req.onerror   = () => rej(req.error);
  });
}

async function isWatching(mal_id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('watched', 'readonly');
    const req = tx.objectStore('watched').get(mal_id);
    req.onsuccess = () => res(!!req.result);
    req.onerror   = () => rej(req.error);
  });
}

/* ---- In-app notification helpers ---- */
async function saveNotification(notif) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('notifications', 'readwrite');
    const req = tx.objectStore('notifications').add({ ...notif, ts: Date.now(), read: false });
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function getAllNotifications() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction('notifications', 'readonly');
    const index = tx.objectStore('notifications').index('ts');
    const req   = index.openCursor(null, 'prev'); // newest first
    const items = [];
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { items.push(cursor.value); cursor.continue(); }
      else res(items);
    };
    req.onerror = () => rej(req.error);
  });
}

async function markAllNotificationsRead() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx    = db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    const req   = store.getAll();
    req.onsuccess = () => {
      req.result.forEach(n => { n.read = true; store.put(n); });
      res();
    };
    req.onerror = () => rej(req.error);
  });
}

async function clearAllNotifications() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('notifications', 'readwrite');
    const req = tx.objectStore('notifications').clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

/* ============================================================
   PUSH NOTIFICATION PERMISSION
   ============================================================ */
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('⚠️ Notifications not supported in this browser.', 'error');
    return false;
  }

  if (Notification.permission === 'granted') return true;

  if (Notification.permission === 'denied') {
    showToast('🔕 Notifications blocked. Enable them in browser settings.', 'error', 5000);
    return false;
  }

  const result = await Notification.requestPermission();
  if (result === 'granted') {
    showToast('🔔 Notifications enabled! You\'ll be alerted for new episodes.', 'success');
    return true;
  }
  return false;
}

/* ============================================================
   EPISODE CHECK — polls Jikan for new episodes
   ============================================================ */
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // every 3 hours

async function checkForNewEpisodes() {
  const watched = await getWatchedList();
  if (!watched.length) return;

  for (const item of watched) {
    // Skip completed anime (no new episodes possible)
    if (item.status === 'Finished Airing') continue;

    try {
      const data = await apiFetch(`/anime/${item.mal_id}`);
      const current = data?.data?.episodes || 0;

      if (current > (item.lastKnownEpisodes || 0)) {
        const title = data.data.title;
        const image = data.data.images?.jpg?.image_url || '';

        // Show in-app notification
        const notif = {
          animeId: item.mal_id,
          title,
          image,
          message: `Episode ${current} is now available!`,
          url: `anime.html?id=${item.mal_id}`,
        };

        await saveNotification(notif);
        updateNotifBell();

        // Show browser notification if permitted
        if (Notification.permission === 'granted') {
          const reg = await navigator.serviceWorker?.ready;
          if (reg?.showNotification) {
            reg.showNotification(`🎌 New Episode — ${title}`, {
              body:    `Episode ${current} is now available!`,
              icon:    image || '/icons/icon-192.png',
              badge:   '/icons/icon-96.png',
              tag:     `ep-${item.mal_id}`,
              vibrate: [200, 100, 200],
              data: { url: `anime.html?id=${item.mal_id}` },
              actions: [
                { action: 'view',    title: '▶ View Anime' },
                { action: 'dismiss', title: '✕ Dismiss'   },
              ],
            });
          } else {
            // Fallback: plain Notification API
            new Notification(`🎌 ${title}`, {
              body: `Episode ${current} is now available!`,
              icon: image || '/icons/icon-192.png',
            });
          }
        }

        // Update stored count
        const db = await openDB();
        db.transaction('watched', 'readwrite')
          .objectStore('watched')
          .put({ ...item, lastKnownEpisodes: current });
      }
    } catch (e) {
      console.warn(`[PWA] Episode check failed for ${item.mal_id}:`, e);
    }

    // Small delay between requests to respect Jikan rate limit
    await new Promise(r => setTimeout(r, 500));
  }
}

/* Schedule periodic checks */
function scheduleEpisodeChecks() {
  const lastCheck = parseInt(localStorage.getItem('lastEpisodeCheck') || '0');
  const now       = Date.now();

  if (now - lastCheck > CHECK_INTERVAL_MS) {
    localStorage.setItem('lastEpisodeCheck', now.toString());
    checkForNewEpisodes();
  }

  // Also register a background sync if supported
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    navigator.serviceWorker.ready
      .then(reg => reg.sync.register('check-episodes'))
      .catch(() => {});
  }
}

/* ============================================================
   NOTIFICATION BELL UI
   ============================================================ */
async function updateNotifBell() {
  const dot = document.querySelector('.notif-dot');
  if (!dot) return;

  const notifs = await getAllNotifications();
  const unread = notifs.filter(n => !n.read).length;
  dot.classList.toggle('active', unread > 0);
}

async function renderNotifPanel() {
  const list = document.getElementById('notifList');
  const perm = Notification.permission;
  const permBtn = document.getElementById('notifPermBtn');

  if (permBtn) {
    if (perm === 'granted') {
      permBtn.textContent = '🔔 Notifications Enabled';
      permBtn.disabled = true;
      permBtn.style.opacity = '0.6';
    } else if (perm === 'denied') {
      permBtn.textContent = '🔕 Notifications Blocked (check settings)';
      permBtn.disabled = true;
      permBtn.style.opacity = '0.6';
    } else {
      permBtn.textContent = '🔔 Enable Notifications';
      permBtn.disabled = false;
    }
  }

  if (!list) return;

  const notifs = await getAllNotifications();

  if (!notifs.length) {
    list.innerHTML = `
      <div class="notif-empty">
        <div class="icon">🔔</div>
        <div>No notifications yet.</div>
        <div style="margin-top:0.4rem;font-size:0.72rem">
          Add anime to your watch list to get episode alerts.
        </div>
      </div>`;
    return;
  }

  list.innerHTML = notifs.slice(0, 20).map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" onclick="window.location='${escAttr(n.url || 'index.html')}'">
      <div class="notif-item-img">
        <img src="${escAttr(n.image || '/icons/icon-96.png')}" alt="" loading="lazy">
      </div>
      <div class="notif-item-body">
        <div class="notif-item-title">${escHtml(n.title || 'Anime Update')}</div>
        <div class="notif-item-msg">${escHtml(n.message || '')}</div>
        <div class="notif-item-time">${formatRelativeTime(n.ts)}</div>
      </div>
    </div>
  `).join('');

  // Mark all as read
  await markAllNotificationsRead();
  updateNotifBell();
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)       return 'just now';
  if (diff < 3600000)     return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000)    return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/* ============================================================
   WATCH BUTTON — injected into anime detail page
   ============================================================ */
async function buildWatchButton(animeData) {
  const watching = await isWatching(animeData.mal_id);

  return `
    <button
      id="watchNotifBtn"
      class="btn ${watching ? 'btn-secondary' : 'btn-secondary'}"
      style="width:100%;justify-content:center;margin-top:0.5rem"
      onclick="toggleWatchNotif()"
    >
      ${watching ? '🔔 Watching (Notifications On)' : '🔕 Watch & Get Notified'}
    </button>
  `;
}

async function toggleWatchNotif() {
  if (!window.animeData) return;
  const anime = window.animeData;
  const btn   = document.getElementById('watchNotifBtn');

  const watching = await isWatching(anime.mal_id);

  if (watching) {
    await removeFromWatched(anime.mal_id);
    if (btn) btn.textContent = '🔕 Watch & Get Notified';
    showToast(`Removed "${anime.title}" from watch list.`, 'info');
  } else {
    // Ask for notification permission first
    const granted = await requestNotificationPermission();
    await addToWatched(anime);
    if (btn) btn.textContent = '🔔 Watching (Notifications On)';
    showToast(`🔔 You'll be notified when "${anime.title}" has new episodes!`, 'success');
    if (!granted) {
      showToast('Enable browser notifications to receive alerts.', 'info', 4000);
    }
  }
}

/* ============================================================
   PWA INSTALL PROMPT
   ============================================================ */
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;

  // Don't show if user dismissed within last 7 days
  const dismissed = parseInt(localStorage.getItem('pwaDismissed') || '0');
  if (Date.now() - dismissed < 7 * 24 * 3600 * 1000) return;

  // Show banner after 3 seconds
  setTimeout(showInstallBanner, 3000);
});

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  hidePWABanner();
  showToast('🎉 AniNexus installed successfully!', 'success');
  localStorage.setItem('pwaInstalled', '1');
});

function showInstallBanner() {
  const banner = document.getElementById('pwaBanner');
  if (banner) banner.classList.add('visible');
}

function hidePWABanner() {
  const banner = document.getElementById('pwaBanner');
  if (banner) banner.classList.remove('visible');
}

async function triggerInstall() {
  if (!_deferredInstallPrompt) {
    showToast('To install: tap browser menu → "Add to Home Screen"', 'info', 5000);
    return;
  }
  hidePWABanner();
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    showToast('🎉 Installing AniNexus…', 'success');
  }
  _deferredInstallPrompt = null;
}

function dismissInstallBanner() {
  hidePWABanner();
  localStorage.setItem('pwaDismissed', Date.now().toString());
}

/* ============================================================
   MOBILE SEARCH OVERLAY
   ============================================================ */
function openMobileSearch() {
  const overlay = document.getElementById('mobileSearchOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.querySelector('input')?.focus();
}

function closeMobileSearch() {
  const overlay = document.getElementById('mobileSearchOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
}

/* ============================================================
   INJECT SHARED PWA HTML ELEMENTS
   Must be called after DOMContentLoaded on every page
   ============================================================ */
function injectPWAElements() {
  // 1. PWA Install Banner
  if (!document.getElementById('pwaBanner')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="pwa-banner" id="pwaBanner">
        <div class="pwa-banner-icon">
          <img src="/icons/icon-192.png" alt="AniNexus">
        </div>
        <div class="pwa-banner-text">
          <div class="pwa-banner-title">Install AniNexus</div>
          <div class="pwa-banner-desc">Add to home screen for offline access & episode alerts</div>
        </div>
        <div class="pwa-banner-actions">
          <button class="btn btn-primary" style="padding:0.5rem 1rem;font-size:0.85rem" onclick="triggerInstall()">
            Install
          </button>
          <button class="pwa-dismiss-btn" onclick="dismissInstallBanner()" title="Dismiss">✕</button>
        </div>
      </div>
    `);
  }

  // 2. Mobile Search Overlay
  if (!document.getElementById('mobileSearchOverlay')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="mobile-search-overlay" id="mobileSearchOverlay">
        <div class="mobile-search-bar">
          <input type="text" id="mobileSearchInput" placeholder="Search anime…" autocomplete="off">
          <button class="btn btn-secondary" style="padding:0.65rem 1rem" onclick="closeMobileSearch()">✕</button>
        </div>
        <div class="mobile-search-results" id="mobileSearchResults"></div>
      </div>
    `);

    // Wire up mobile search input
    const mobileInput = document.getElementById('mobileSearchInput');
    let mobileTimer;
    mobileInput?.addEventListener('input', () => {
      clearTimeout(mobileTimer);
      const q = mobileInput.value.trim();
      if (q.length < 2) {
        document.getElementById('mobileSearchResults').innerHTML = '';
        return;
      }
      mobileTimer = setTimeout(() =>
        performSearch(q, document.getElementById('mobileSearchResults'))
      , 450);
    });
    mobileInput?.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeMobileSearch();
    });
  }

  // 3. Notification Bell in navbar (add search icon for mobile + bell)
  const navControls = document.querySelector('.nav-controls');
  if (navControls && !document.getElementById('notifBellBtn')) {
    // Add mobile search icon before dark mode btn
    navControls.insertAdjacentHTML('afterbegin', `
      <button class="btn-icon" id="mobileSearchBtn" title="Search" style="display:none">🔍</button>
    `);

    // Add notification bell
    navControls.insertAdjacentHTML('afterbegin', `
      <div class="notif-bell">
        <button class="btn-icon" id="notifBellBtn" title="Notifications">🔔</button>
        <div class="notif-dot" id="notifDot"></div>
      </div>
    `);

    // Notification panel
    document.body.insertAdjacentHTML('beforeend', `
      <div class="notif-panel" id="notifPanel">
        <div class="notif-panel-header">
          <div class="notif-panel-title">🔔 Notifications</div>
          <button class="notif-panel-clear" id="notifClearBtn">Clear all</button>
        </div>
        <div class="notif-list" id="notifList">
          <div class="notif-empty"><div class="icon">🔔</div><div>Loading…</div></div>
        </div>
        <div class="notif-panel-footer">
          <button class="btn btn-secondary notif-perm-btn" id="notifPermBtn" onclick="requestNotificationPermission()">
            🔔 Enable Notifications
          </button>
        </div>
      </div>
    `);

    // Bell click handler
    document.getElementById('notifBellBtn').addEventListener('click', e => {
      e.stopPropagation();
      const panel = document.getElementById('notifPanel');
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) renderNotifPanel();
    });

    // Close panel on outside click
    document.addEventListener('click', e => {
      const panel = document.getElementById('notifPanel');
      const bell  = document.querySelector('.notif-bell');
      if (panel && !panel.contains(e.target) && !bell?.contains(e.target)) {
        panel.classList.remove('open');
      }
    });

    // Clear notifications
    document.getElementById('notifClearBtn').addEventListener('click', async () => {
      await clearAllNotifications();
      renderNotifPanel();
      updateNotifBell();
    });

    // Mobile search button (visible on ≤ 768px)
    const mobileSearchBtn = document.getElementById('mobileSearchBtn');
    mobileSearchBtn?.addEventListener('click', openMobileSearch);

    // Show mobile search btn on small screens
    function updateMobileSearchVisibility() {
      if (!mobileSearchBtn) return;
      mobileSearchBtn.style.display = window.innerWidth <= 768 ? 'flex' : 'none';
    }
    updateMobileSearchVisibility();
    window.addEventListener('resize', updateMobileSearchVisibility);
  }

  // Init bell state
  updateNotifBell();
}

/* ============================================================
   GLOBAL PWA INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  registerSW();
  injectPWAElements();
  scheduleEpisodeChecks();
});
