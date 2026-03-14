/* ============================================================
   ANIME DISCOVERY — Main JavaScript
   Handles: API calls, caching, search, favorites, UI helpers
   ============================================================ */

'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const JIKAN_BASE   = 'https://api.jikan.moe/v4';
const CACHE_TTL    = 5 * 60 * 1000;   // 5 minutes
const DEBOUNCE_MS  = 450;
const IMG_FALLBACK = 'https://via.placeholder.com/225x320/111827/00e5ff?text=No+Image';

/* ============================================================
   API CACHE — in-memory + sessionStorage
   ============================================================ */
const cache = {
  _store: {},

  key(url) { return `jikan_cache_${url}`; },

  get(url) {
    const key   = this.key(url);
    const local = sessionStorage.getItem(key);
    if (local) {
      try {
        const { data, ts } = JSON.parse(local);
        if (Date.now() - ts < CACHE_TTL) return data;
      } catch (e) {}
    }
    if (this._store[url] && Date.now() - this._store[url].ts < CACHE_TTL) {
      return this._store[url].data;
    }
    return null;
  },

  set(url, data) {
    const key = this.key(url);
    this._store[url] = { data, ts: Date.now() };
    try {
      sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
    } catch (e) { /* quota exceeded */ }
  }
};

/* ============================================================
   API FETCH WRAPPER
   Handles rate-limiting with automatic retry (Jikan = 3 req/s)
   ============================================================ */
async function apiFetch(endpoint, useCache = true) {
  const url = endpoint.startsWith('http') ? endpoint : `${JIKAN_BASE}${endpoint}`;

  if (useCache) {
    const hit = cache.get(url);
    if (hit) return hit;
  }

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetch(url);

      // Jikan rate limit: wait and retry
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        attempt++;
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      if (useCache) cache.set(url, json);
      return json;

    } catch (err) {
      attempt++;
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(800 * attempt);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   FAVORITES — localStorage helpers
   ============================================================ */
const favorites = {
  _key: 'anime_favorites',

  getAll() {
    try { return JSON.parse(localStorage.getItem(this._key)) || []; }
    catch (e) { return []; }
  },

  has(id) {
    return this.getAll().some(a => a.mal_id === id);
  },

  toggle(anime) {
    const all = this.getAll();
    const idx = all.findIndex(a => a.mal_id === anime.mal_id);
    if (idx === -1) {
      all.push(anime);
      showToast(`Added "${anime.title}" to favorites ❤️`, 'success');
    } else {
      all.splice(idx, 1);
      showToast(`Removed "${anime.title}" from favorites`, 'info');
    }
    localStorage.setItem(this._key, JSON.stringify(all));
    return idx === -1; // true = added
  },

  remove(id) {
    const all = this.getAll().filter(a => a.mal_id !== id);
    localStorage.setItem(this._key, JSON.stringify(all));
  }
};

/* ============================================================
   DARK MODE TOGGLE
   ============================================================ */
function initDarkMode() {
  const btn = document.getElementById('darkModeBtn');
  if (!btn) return;

  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light-mode');
    btn.textContent = '☀️';
  }

  btn.addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    const isLight = document.body.classList.contains('light-mode');
    btn.textContent = isLight ? '☀️' : '🌙';
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  });
}

/* ============================================================
   MOBILE MENU
   ============================================================ */
function initMobileMenu() {
  const hamburger  = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');
  const closeBtn   = document.getElementById('mobileMenuClose');
  if (!hamburger || !mobileMenu) return;

  hamburger.addEventListener('click', () => mobileMenu.classList.add('open'));
  closeBtn?.addEventListener('click', () => mobileMenu.classList.remove('open'));
  mobileMenu.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => mobileMenu.classList.remove('open'))
  );
}

/* ============================================================
   GLOBAL SEARCH (navbar)
   ============================================================ */
function initSearch() {
  const input    = document.getElementById('globalSearch');
  const dropdown = document.getElementById('searchDropdown');
  if (!input || !dropdown) return;

  let timer;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { dropdown.classList.remove('open'); return; }
    timer = setTimeout(() => performSearch(q, dropdown), DEBOUNCE_MS);
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!input.closest('.nav-search').contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') dropdown.classList.remove('open');
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q) window.location.href = `index.html?search=${encodeURIComponent(q)}`;
    }
  });
}

async function performSearch(query, dropdown) {
  dropdown.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted)">Searching…</div>';
  dropdown.classList.add('open');

  try {
    const data = await apiFetch(`/anime?q=${encodeURIComponent(query)}&limit=8&sfw=true`);
    const list = data.data || [];

    if (!list.length) {
      dropdown.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted)">No results found</div>';
      return;
    }

    dropdown.innerHTML = list.map(a => `
      <div class="search-result-item" onclick="window.location='anime.html?id=${a.mal_id}'">
        <img src="${a.images?.jpg?.image_url || IMG_FALLBACK}" alt="${a.title}" loading="lazy">
        <div class="search-result-info">
          <div class="title">${escHtml(a.title)}</div>
          <div class="meta">
            ${a.type || 'Anime'} · ${a.score ? '⭐ ' + a.score : 'N/A'} · ${a.episodes || '?'} eps
          </div>
        </div>
      </div>
    `).join('');

  } catch (e) {
    dropdown.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--neon-pink)">Search failed. Try again.</div>';
  }
}

/* ============================================================
   CARD BUILDER
   Returns HTML string for an anime card
   ============================================================ */
function buildCard(anime, opts = {}) {
  const {
    title    = anime.title || 'Unknown',
    image    = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || IMG_FALLBACK,
    score    = anime.score,
    episodes = anime.episodes,
    synopsis = anime.synopsis || '',
    type     = anime.type,
    year     = anime.year || (anime.aired?.prop?.from?.year),
    season   = anime.season,
    id       = anime.mal_id,
  } = opts;

  const short = synopsis.length > 150 ? synopsis.slice(0, 148) + '…' : synopsis;
  const isFav = favorites.has(id);
  const typeClass = type ? `type-${type.replace(/\s+/g, '')}` : '';

  return `
    <article class="anime-card" onclick="navigateTo('anime.html?id=${id}')">
      <div class="card-poster">
        <img
          src="${IMG_FALLBACK}"
          data-src="${escAttr(image)}"
          alt="${escAttr(title)}"
          class="lazy"
          loading="lazy"
        >
        ${score ? `<div class="score-badge">⭐ ${score}</div>` : ''}
        <button
          class="fav-btn ${isFav ? 'active' : ''}"
          onclick="event.stopPropagation(); toggleFav(this, ${id}, event)"
          data-id="${id}"
          title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
          aria-label="Favorite"
        >${isFav ? '❤️' : '🤍'}</button>
      </div>
      <div class="card-body">
        ${type ? `<span class="type-tag ${typeClass}">${type}</span>` : ''}
        <h3 class="card-title mt-1">${escHtml(title)}</h3>
        <div class="card-meta">
          ${episodes ? `<span>📺 ${episodes} eps</span>` : ''}
          ${season && year ? `<span>📅 ${capitalize(season)} ${year}</span>` : year ? `<span>📅 ${year}</span>` : ''}
        </div>
        ${short ? `<p class="card-synopsis">${escHtml(short)}</p>` : ''}
      </div>
    </article>
  `;
}

/* ============================================================
   SKELETON CARDS
   ============================================================ */
function buildSkeletons(count = 12) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton skeleton-poster"></div>
      <div class="skeleton-body">
        <div class="skeleton skeleton-line title"></div>
        <div class="skeleton skeleton-line short"></div>
        <div class="skeleton skeleton-line xs"></div>
      </div>
    </div>
  `).join('');
}

/* ============================================================
   FAVORITE TOGGLE (called from card onclick)
   ============================================================ */
function toggleFav(btn, id, e) {
  // Gather minimal anime data stored with favorites
  const card    = btn.closest('.anime-card');
  const title   = card.querySelector('.card-title')?.textContent || 'Unknown';
  const imgEl   = card.querySelector('img');
  const image   = imgEl?.src || IMG_FALLBACK;

  const anime = { mal_id: id, title, images: { jpg: { image_url: image } } };
  const added = favorites.toggle(anime);

  btn.textContent = added ? '❤️' : '🤍';
  btn.classList.toggle('active', added);
  btn.title = added ? 'Remove from favorites' : 'Add to favorites';

  // If on favorites page, remove card
  if (window.location.pathname.includes('favorites') && !added) {
    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    setTimeout(() => {
      card.remove();
      checkEmptyFavorites();
    }, 300);
  }
}

function checkEmptyFavorites() {
  const grid = document.getElementById('favGrid');
  if (!grid) return;
  if (grid.children.length === 0) {
    grid.innerHTML = emptyState('💔', 'No favorites yet', 'Browse anime and tap ❤️ to save them here.');
  }
}

/* ============================================================
   LAZY LOADING — IntersectionObserver for images
   ============================================================ */
function initLazyLoad(root = document) {
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        obs.unobserve(img);
      }
    });
  }, { rootMargin: '200px' });

  root.querySelectorAll('img.lazy').forEach(img => io.observe(img));
}

/* ============================================================
   INFINITE SCROLL HELPER
   ============================================================ */
function createInfiniteScroll(triggerEl, onLoad) {
  const io = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) onLoad();
  }, { rootMargin: '300px' });
  if (triggerEl) io.observe(triggerEl);
  return io;
}

/* ============================================================
   TOAST NOTIFICATION
   ============================================================ */
function showToast(msg, type = 'info', duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

/* ============================================================
   ERROR STATE
   ============================================================ */
function errorState(msg = 'Failed to load. Please try again.') {
  return `
    <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--neon-pink)">
      <div style="font-size:2.5rem;margin-bottom:0.75rem">⚠️</div>
      <div style="font-weight:600">${msg}</div>
    </div>
  `;
}

function emptyState(icon, title, msg) {
  return `
    <div class="empty-state" style="grid-column:1/-1">
      <div class="icon">${icon}</div>
      <h3>${title}</h3>
      <p>${msg}</p>
    </div>
  `;
}

/* ============================================================
   COUNTDOWN TIMER
   ============================================================ */
function startCountdown(targetDate, numEls, onEnd) {
  function tick() {
    const diff = new Date(targetDate) - Date.now();
    if (diff <= 0) { onEnd?.(); return; }

    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    const vals = [d, h, m, s];
    numEls.forEach((el, i) => { if (el) el.textContent = String(vals[i]).padStart(2, '0'); });
  }
  tick();
  return setInterval(tick, 1000);
}

/* ============================================================
   ACTIVE NAV LINK
   ============================================================ */
function setActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href')?.split('/').pop();
    a.classList.toggle('active', href === path);
  });
}

/* ============================================================
   NAVIGATE HELPER
   ============================================================ */
function navigateTo(url) { window.location.href = url; }

/* ============================================================
   URL PARAM HELPER
   ============================================================ */
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/* ============================================================
   HELPERS
   ============================================================ */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/* ============================================================
   GENRE LIST (Jikan genre IDs for filter UI)
   ============================================================ */
const GENRES = [
  { id: 1, name: 'Action' },      { id: 2, name: 'Adventure' },
  { id: 4, name: 'Comedy' },      { id: 8, name: 'Drama' },
  { id: 10, name: 'Fantasy' },    { id: 14, name: 'Horror' },
  { id: 7, name: 'Mystery' },     { id: 22, name: 'Romance' },
  { id: 24, name: 'Sci-Fi' },     { id: 36, name: 'Slice of Life' },
  { id: 30, name: 'Sports' },     { id: 37, name: 'Supernatural' },
  { id: 41, name: 'Thriller' },   { id: 62, name: 'Isekai' },
];

/* ============================================================
   GLOBAL INIT (runs on every page)
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initDarkMode();
  initMobileMenu();
  initSearch();
  setActiveNav();
});
