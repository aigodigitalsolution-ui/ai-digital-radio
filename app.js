/**
 * AI Digital Radio — Worldwide stations via Radio Browser API
 * AI Agent "updates" the station list by fetching live data
 */

// Seed mirrors — refreshed at runtime via live server discovery
const API_BASES_SEED = [
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://all.api.radio-browser.info'
];

let API_BASES = [...API_BASES_SEED];
let currentApi = API_BASES[0];
let stations = [];
let currentStation = null;
let favorites = [];
let isPlaying = false;
let serversDiscovered = false;

// Local health knowledge (learned from real playback attempts)
// { [stationuuid]: { status: 'ok'|'dead'|'unknown', checkedAt: number, fails: number } }
let healthCache = {};
const HEALTH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // remember for 7 days
const MAX_FAILS_BEFORE_HIDE = 2;

// DOM
const searchInput = document.getElementById('searchInput');
const clearSearch = document.getElementById('clearSearch');
const countryFilter = document.getElementById('countryFilter');
const tagFilter = document.getElementById('tagFilter');
const sortFilter = document.getElementById('sortFilter');
const stationGrid = document.getElementById('stationGrid');
const emptyState = document.getElementById('emptyState');
const stationCount = document.getElementById('stationCount');
const lastUpdated = document.getElementById('lastUpdated');
const updateBtn = document.getElementById('updateBtn');
const aiStatus = document.getElementById('aiStatus');
const aiMessage = document.getElementById('aiMessage');
const nowPlaying = document.getElementById('nowPlaying');
const audioPlayer = document.getElementById('audioPlayer');
const npImg = document.getElementById('npImg');
const npName = document.getElementById('npName');
const npMeta = document.getElementById('npMeta');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const stopBtn = document.getElementById('stopBtn');
const favBtn = document.getElementById('favBtn');
const favOutline = document.getElementById('favOutline');
const favFilled = document.getElementById('favFilled');
const eqBars = document.getElementById('eqBars');
const bufBarFill = document.getElementById('bufBarFill');
const bufStateEl = document.getElementById('bufState');
const bufTransportEl = document.getElementById('bufTransport');
const bufBufferedEl = document.getElementById('bufBuffered');
const bufReadyEl = document.getElementById('bufReady');
const bufNetEl = document.getElementById('bufNet');

// Buffer monitor state
let bufferMonitorId = null;
let lastBufferedEnd = 0;
let stallCount = 0;
let isOnline = navigator.onLine;
let activeTransport = 'http'; // 'http' | 'websocket' | 'mse'

// ============================================================
// ErrorHandler — centralized errors, toasts, storage, networking
// ============================================================
const ErrorHandler = (() => {
  const MEDIA_ERRORS = {
    1: 'Playback aborted',
    2: 'Network error — stream unreachable',
    3: 'Decode error — unsupported or corrupt stream',
    4: 'Source not supported by this browser'
  };

  const ICONS = { error: '⚠', info: 'ℹ', success: '✓' };
  let toastTimer = null;

  // --- Toast UI ---
  function toast(message, type = 'error', durationMs = 4500) {
    const el = document.getElementById('toast');
    const msg = document.getElementById('toastMsg');
    const icon = document.getElementById('toastIcon');
    if (!el || !msg) {
      console.warn('[toast]', type, message);
      return;
    }
    el.classList.remove('info', 'success', 'visible');
    if (type === 'info' || type === 'success') el.classList.add(type);
    if (icon) icon.textContent = ICONS[type] || ICONS.error;
    msg.textContent = message;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, durationMs);
  }

  function hideToast() {
    const el = document.getElementById('toast');
    if (!el) return;
    el.classList.remove('visible');
    setTimeout(() => { el.hidden = true; }, 300);
  }

  // --- Typed errors ---
  function AppError(code, message, cause) {
    const err = new Error(message);
    err.name = 'AppError';
    err.code = code;
    err.cause = cause || null;
    return err;
  }

  function fromMedia(audio) {
    const mediaErr = audio && audio.error;
    if (!mediaErr) return AppError('MEDIA_UNKNOWN', 'Unknown playback error');
    return AppError(
      'MEDIA_' + mediaErr.code,
      MEDIA_ERRORS[mediaErr.code] || `Media error code ${mediaErr.code}`,
      mediaErr
    );
  }

  function fromNetwork(err) {
    if (!isOnline) return AppError('OFFLINE', 'You appear to be offline', err);
    if (err && err.name === 'AbortError') return AppError('TIMEOUT', 'Request timed out', err);
    if (err && err.name === 'NotAllowedError') {
      return AppError('AUTOPLAY', 'Browser blocked autoplay — tap play', err);
    }
    if (err && err.name === 'NotSupportedError') {
      return AppError('UNSUPPORTED', 'Stream format not supported by this browser', err);
    }
    if (err && /Failed to fetch|NetworkError|Load failed|network error/i.test(err.message || '')) {
      return AppError('NETWORK', 'Network request failed', err);
    }
    return AppError('NETWORK', (err && err.message) || 'Network error', err);
  }

  function fromUnknown(err) {
    if (!err) return AppError('UNKNOWN', 'Something went wrong');
    if (err.code && err.name === 'AppError') return err;
    if (err.name === 'AppError') return err;
    if (err.name === 'NotAllowedError' || err.name === 'NotSupportedError' || err.name === 'AbortError') {
      return fromNetwork(err);
    }
    if (err.code && MEDIA_ERRORS[err.code]) return fromMedia({ error: err });
    return AppError('UNKNOWN', err.message || String(err), err);
  }

  function messageOf(err) {
    if (!err) return 'Something went wrong';
    if (err.code && err.message) return err.message;
    return err.message || String(err);
  }

  /** Validate a stream URL before playback */
  function validateStreamUrl(url) {
    if (!url || typeof url !== 'string') {
      return AppError('BAD_URL', 'Station has no stream URL');
    }
    const trimmed = url.trim();
    if (!trimmed) return AppError('BAD_URL', 'Station has an empty stream URL');
    if (!/^(https?:|wss?:)\/\//i.test(trimmed)) {
      return AppError('BAD_URL', 'Invalid stream URL protocol');
    }
    // Mixed content: page is HTTPS but stream is plain HTTP — browsers often block
    if (typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//i.test(trimmed)) {
      // Warning only — many radios still work via upgraded paths; return null = ok with caution
      return null;
    }
    return null; // valid
  }

  /** Run fn; on throw, normalize + toast + optional rethrow */
  function guard(fn, opts = {}) {
    const { label = 'Action', silent = false, rethrow = false } = opts;
    try {
      return fn();
    } catch (e) {
      const appErr = fromUnknown(e);
      console.error(label + ' failed:', appErr);
      if (!silent) toast(messageOf(appErr), 'error');
      if (rethrow) throw appErr;
      return undefined;
    }
  }

  async function guardAsync(fn, opts = {}) {
    const { label = 'Action', silent = false, rethrow = false } = opts;
    try {
      return await fn();
    } catch (e) {
      const appErr = fromUnknown(e);
      console.error(label + ' failed:', appErr);
      if (!silent) toast(messageOf(appErr), 'error');
      if (rethrow) throw appErr;
      return undefined;
    }
  }

  // --- Safe localStorage ---
  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('storageGet failed:', key, e);
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('storageSet failed:', key, e);
      if (e && e.name === 'QuotaExceededError') {
        toast('Storage full — some data may not persist', 'info', 3000);
      }
      return false;
    }
  }

  // --- Promise helpers ---
  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function withTimeout(promise, ms, label = 'Operation') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(AppError('TIMEOUT', `${label} timed out after ${ms}ms`)),
        ms
      );
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); }
      );
    });
  }

  // --- Live mirror discovery ---
  async function discoverServers() {
    // Probe seed hosts for /json/servers (or /json/stats as health check)
    const candidates = [...API_BASES_SEED];
    for (const base of candidates) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(base + '/json/servers', {
          method: 'GET',
          mode: 'cors',
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0) continue;

        const discovered = [];
        list.forEach(s => {
          const name = (s && (s.name || s)) || '';
          if (typeof name === 'string' && name.includes('api.radio-browser.info')) {
            const host = name.replace(/\.$/, '');
            const url = host.startsWith('http') ? host : 'https://' + host;
            if (!discovered.includes(url)) discovered.push(url);
          }
        });

        if (discovered.length) {
          // Prefer discovered, keep seeds as fallback
          API_BASES = [...discovered, ...API_BASES_SEED.filter(b => !discovered.includes(b))];
          currentApi = API_BASES[0];
          serversDiscovered = true;
          console.info('Radio Browser mirrors discovered:', API_BASES.length, API_BASES);
          return API_BASES;
        }
      } catch (e) {
        console.warn('Server discovery probe failed:', base, e.message || e);
      }
    }

    // Fallback: keep seeds, mark first reachable via stats
    for (const base of API_BASES_SEED) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(base + '/json/stats', {
          method: 'GET',
          mode: 'cors',
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          currentApi = base;
          serversDiscovered = true;
          console.info('Using reachable seed mirror:', base);
          return API_BASES;
        }
      } catch (_) { /* try next */ }
    }

    console.warn('Could not discover live Radio Browser mirrors — using seed list');
    return API_BASES;
  }

  // --- API fetch with mirror failover ---
  async function apiFetch(path, params = {}, options = {}) {
    const { timeoutMs = 15000, retries = 2 } = options;
    const query = new URLSearchParams(params).toString();
    const relative = `${path}${query ? '?' + query : ''}`;

    if (!isOnline) throw AppError('OFFLINE', 'You appear to be offline');

    // Ensure we have tried discovery once
    if (!serversDiscovered) {
      try { await discoverServers(); } catch (_) { /* continue with seeds */ }
    }

    const mirrors = [...API_BASES];
    const startIdx = mirrors.indexOf(currentApi);
    if (startIdx > 0) mirrors.push(...mirrors.splice(0, startIdx));

    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      for (const base of mirrors) {
        if (!isOnline) throw AppError('OFFLINE', 'You appear to be offline');
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const res = await fetch(base + relative, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            signal: controller.signal
            // Note: do NOT set User-Agent — browsers forbid it and it can break CORS
          });
          clearTimeout(timer);

          if (res.ok) {
            currentApi = base;
            try {
              return await res.json();
            } catch (parseErr) {
              lastError = AppError('PARSE', 'Invalid JSON from ' + base, parseErr);
              continue;
            }
          }

          lastError = AppError('HTTP_' + res.status, `HTTP ${res.status} from ${base}`);
          if (res.status === 429) await delay(800);
          if (res.status >= 500) await delay(200);
        } catch (e) {
          lastError = fromNetwork(e);
          console.warn('API mirror failed:', base, messageOf(lastError));
        }
      }
      if (attempt < retries) {
        // On full cycle failure, re-discover mirrors once
        if (attempt === 0) {
          serversDiscovered = false;
          try { await discoverServers(); } catch (_) { /* ignore */ }
        }
        await delay(500 * (attempt + 1));
      }
    }

    throw lastError || AppError('API_DOWN', 'Could not connect to any Radio Browser server. Check your network or try again later.');
  }

  // --- Connectivity ---
  function setOnline(value) {
    isOnline = value;
  }

  function requireOnline(actionLabel = 'This action') {
    if (isOnline) return true;
    toast(`${actionLabel} needs an internet connection`, 'error');
    return false;
  }

  // Public API
  return {
    toast,
    hideToast,
    AppError,
    fromMedia,
    fromNetwork,
    fromUnknown,
    messageOf,
    validateStreamUrl,
    guard,
    guardAsync,
    storageGet,
    storageSet,
    delay,
    withTimeout,
    apiFetch,
    discoverServers,
    setOnline,
    requireOnline
  };
})();

// Backwards-compatible aliases used across the app
const showToast = ErrorHandler.toast;
const hideToast = ErrorHandler.hideToast;
const safeLocalStorageGet = ErrorHandler.storageGet;
const safeLocalStorageSet = ErrorHandler.storageSet;
const describeMediaError = (audio) => ErrorHandler.messageOf(ErrorHandler.fromMedia(audio));
const fetchJson = (path, params, options) => ErrorHandler.apiFetch(path, params, options);

// ---------- AI Agent simulation messages ----------
const AI_MESSAGES = [
  'AI Agent is scanning worldwide radio networks...',
  'Querying global station databases across 240+ countries...',
  'Discovering high-bitrate digital streams...',
  'Exploring popular genres: rock, jazz, news, electronic...',
  'Checking top stations in Americas, Europe, Asia & more...',
  'Filtering working streams & ranking by listener activity...',
  'Cross-referencing tags, languages, codecs & bitrates...',
  'Compiling a rich multi-region station collection...'
];

function showAiStatus(msg) {
  aiMessage.textContent = msg || AI_MESSAGES[Math.floor(Math.random() * AI_MESSAGES.length)];
  aiStatus.hidden = false;
}

function hideAiStatus() {
  aiStatus.hidden = true;
}

// ---------- Live Stream Health System ----------
function saveHealthCache() {
  safeLocalStorageSet('ai-radio-health', healthCache);
}

function getHealth(uuid) {
  const entry = healthCache[uuid];
  if (!entry) return { status: 'unknown', fails: 0 };
  // Expire old entries
  if (Date.now() - (entry.checkedAt || 0) > HEALTH_TTL_MS) {
    delete healthCache[uuid];
    return { status: 'unknown', fails: 0 };
  }
  return entry;
}

function markHealthy(uuid) {
  healthCache[uuid] = { status: 'ok', checkedAt: Date.now(), fails: 0 };
  saveHealthCache();
}

function markUnhealthy(uuid) {
  const prev = getHealth(uuid);
  const fails = (prev.fails || 0) + 1;
  healthCache[uuid] = {
    status: fails >= MAX_FAILS_BEFORE_HIDE ? 'dead' : 'suspect',
    checkedAt: Date.now(),
    fails
  };
  saveHealthCache();
}

/** Compute a health-aware score used for ranking */
function healthScore(station) {
  let score = 0;
  // Radio Browser remote checks
  if (station.lastcheckok === 1) score += 40;
  else if (station.lastcheckok === 0) score -= 80;

  // Recent successful check is valuable
  if (station.lastcheckoktime_iso8601) {
    const ageH = (Date.now() - new Date(station.lastcheckoktime_iso8601).getTime()) / 3600000;
    if (ageH < 24) score += 25;
    else if (ageH < 72) score += 12;
    else if (ageH < 168) score += 5;
  }

  // Local learned health
  const local = getHealth(station.stationuuid);
  if (local.status === 'ok') score += 50;
  else if (local.status === 'suspect') score -= 30;
  else if (local.status === 'dead') score -= 200;

  // Quality signals
  if (station.bitrate >= 128) score += 15;
  else if (station.bitrate >= 64) score += 5;
  if (station.codec && /aac|mp3/i.test(station.codec)) score += 5;
  if (station.ssl_error) score -= 20;

  // Popularity (normalized lightly)
  score += Math.min(30, Math.log10((station.clickcount || 1) + 1) * 8);
  score += Math.min(15, Math.log10((station.votes || 1) + 1) * 5);

  return score;
}

/** Is this station currently considered playable? */
function isStationHealthy(station) {
  const local = getHealth(station.stationuuid);
  if (local.status === 'dead') return false;
  // Trust Radio Browser majority vote when we have no local knowledge
  if (station.lastcheckok === 0 && local.status === 'unknown') return false;
  return true;
}

// Popular genres the AI Agent will actively hunt for
const POPULAR_TAGS = [
  'pop', 'rock', 'news', 'jazz', 'classical', 'electronic', 'dance',
  'hip hop', 'hiphop', 'country', 'metal', 'blues', 'reggae', 'folk',
  'talk', 'sport', 'ambient', 'chill', 'house', 'techno', 'indie',
  'soul', 'rnb', 'rap', 'latin', 'world', 'oldies', '80s', '90s',
  'christian', 'gospel', 'lounge', 'trance', 'drum and bass'
];

// Major countries for geographic diversity (includes Indonesia for local relevance)
const MAJOR_COUNTRIES = [
  'United States', 'United Kingdom', 'Germany', 'France', 'Canada',
  'Australia', 'Japan', 'India', 'Brazil', 'Indonesia', 'Netherlands',
  'Italy', 'Spain', 'Mexico', 'South Korea', 'Sweden', 'Poland',
  'Turkey', 'Russia', 'South Africa', 'Argentina', 'Thailand',
  'Philippines', 'Malaysia', 'Singapore', 'Egypt', 'Nigeria'
];

// Simple concurrency limiter so we don't overwhelm the public API
async function runInBatches(items, batchSize, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

// ---------- Load stations (rich multi-source scan) ----------
async function loadStations(isUpdate = false) {
  if (isUpdate) {
    updateBtn.classList.add('loading');
    showAiStatus('AI Agent launching full worldwide scan...');
  } else {
    stationGrid.innerHTML = Array(12).fill('<div class="skeleton"></div>').join('');
  }

  const map = new Map();

  const addStations = (list) => {
    if (!Array.isArray(list)) return;
    list.forEach(s => {
      if (s && s.stationuuid && (s.url_resolved || s.url) && !map.has(s.stationuuid)) {
        // Skip stations known broken by Radio Browser OR by our local health cache
        if (s.lastcheckok === 0) return;
        if (getHealth(s.stationuuid).status === 'dead') return;
        map.set(s.stationuuid, s);
      }
    });
  };

  try {
    // Phase 0 – Connect to Radio Browser network
    if (isUpdate) showAiStatus('Phase 0/5 · Connecting to Radio Browser network…');
    serversDiscovered = false;
    await ErrorHandler.discoverServers();
    if (isUpdate) {
      showAiStatus(`Connected via ${currentApi.replace('https://', '')} · scanning…`);
    }

    // Phase 1 – Global popularity ranking
    if (isUpdate) showAiStatus('Phase 1/5 · Ranking most-clicked & most-voted stations worldwide...');
    const [byClicks, byVotes, byLastClick] = await Promise.all([
      fetchJson('/json/stations/topclick/250'),
      fetchJson('/json/stations/topvote/200'),
      fetchJson('/json/stations/lastclick/150')
    ]);
    addStations(byClicks);
    addStations(byVotes);
    addStations(byLastClick);

    // Phase 2 – Genre deep-dive (batched to be friendly to the public API)
    if (isUpdate) showAiStatus('Phase 2/5 · Exploring 30+ popular genres & formats...');
    const tagResults = await runInBatches(POPULAR_TAGS, 8, tag =>
      fetchJson('/json/stations/search', {
        tag: tag,
        order: 'clickcount',
        reverse: 'true',
        limit: 40,
        hidebroken: 'true'
      }).catch(() => [])
    );
    tagResults.forEach(addStations);

    // Phase 3 – Geographic coverage across major countries
    if (isUpdate) showAiStatus('Phase 3/5 · Scanning major countries on every continent...');
    const countryResults = await runInBatches(MAJOR_COUNTRIES, 7, country =>
      fetchJson('/json/stations/search', {
        country: country,
        order: 'clickcount',
        reverse: 'true',
        limit: 30,
        hidebroken: 'true'
      }).catch(() => [])
    );
    countryResults.forEach(addStations);

    // Phase 4 – High-quality / high-bitrate + recently changed streams
    if (isUpdate) showAiStatus('Phase 4/5 · Collecting high-bitrate & recent streams...');
    const [highBitrate, recent] = await Promise.all([
      fetchJson('/json/stations/search', {
        order: 'bitrate',
        reverse: 'true',
        limit: 100,
        hidebroken: 'true',
        bitrateMin: 128
      }).catch(() => []),
      fetchJson('/json/stations/search', {
        order: 'changetimestamp',
        reverse: 'true',
        limit: 80,
        hidebroken: 'true'
      }).catch(() => [])
    ]);
    addStations(highBitrate);
    addStations(recent);

    // Phase 5 – Health scoring & filtering
    if (isUpdate) showAiStatus('Phase 5/5 · Running live health analysis on discovered streams...');
    let candidates = Array.from(map.values());

    // Apply health filter + score ranking
    candidates = candidates.filter(isStationHealthy);
    candidates.forEach(s => { s._healthScore = healthScore(s); });
    candidates.sort((a, b) => (b._healthScore || 0) - (a._healthScore || 0));

    // Cap for UI performance while keeping a rich catalogue
    if (candidates.length > 1400) {
      candidates = candidates.slice(0, 1400);
    }

    stations = candidates;

    const healthyCount = stations.filter(s => {
      const h = getHealth(s.stationuuid);
      return h.status === 'ok' || s.lastcheckok === 1;
    }).length;

    populateFilters(stations);
    renderStations();

    const now = new Date();
    lastUpdated.textContent = isUpdate
      ? `AI Agent updated · ${stations.length} healthy stations · ${now.toLocaleTimeString()}`
      : `Loaded · ${stations.length} stations · ${now.toLocaleTimeString()}`;
    stationCount.textContent = `${stations.length} stations`;

    if (isUpdate) {
      showAiStatus(`✅ AI Agent complete! ${stations.length} healthy stations (${healthyCount} verified).`);
      setTimeout(hideAiStatus, 3500);
    }
  } catch (err) {
    console.error('loadStations failed:', err);
    const appErr = err.code ? err : ErrorHandler.fromNetwork(err);
    const msg = ErrorHandler.messageOf(appErr);

    stationGrid.innerHTML = '';
    emptyState.hidden = false;
    emptyState.querySelector('h3').textContent = 'Network failed to connect';
    emptyState.querySelector('p').textContent =
      msg + ' Tip: disable VPN/ad-block for this site, check internet, then press Update Stations.';
    lastUpdated.textContent = 'Connection failed';
    ErrorHandler.toast(msg, 'error', 6000);

    if (isUpdate) {
      showAiStatus('❌ Network failed to connect. Try Update again.');
      setTimeout(hideAiStatus, 4000);
    }
  } finally {
    updateBtn.classList.remove('loading');
  }
}

function populateFilters(list) {
  const countries = new Set();
  const tags = new Set();

  list.forEach(s => {
    if (s.country) countries.add(s.country);
    if (s.tags) {
      s.tags.split(',').forEach(t => {
        const clean = t.trim().toLowerCase();
        if (clean && clean.length > 1) tags.add(clean);
      });
    }
  });

  // Keep current selection if possible
  const prevCountry = countryFilter.value;
  const prevTag = tagFilter.value;

  countryFilter.innerHTML = '<option value="">All Countries</option>';
  [...countries].sort().forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    countryFilter.appendChild(opt);
  });
  if (prevCountry) countryFilter.value = prevCountry;

  tagFilter.innerHTML = '<option value="">All Genres</option>';
  // Show many genres so the richer list is fully filterable
  [...tags].sort().slice(0, 200).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    tagFilter.appendChild(opt);
  });
  if (prevTag) tagFilter.value = prevTag;
}

// ---------- Render ----------
function getFilteredStations() {
  const q = searchInput.value.trim().toLowerCase();
  const country = countryFilter.value;
  const tag = tagFilter.value;
  const sort = sortFilter.value;

  let filtered = stations.filter(s => {
    // Always hide locally confirmed dead stations
    if (getHealth(s.stationuuid).status === 'dead') return false;
    if (country && s.country !== country) return false;
    if (tag) {
      const tags = (s.tags || '').toLowerCase();
      if (!tags.includes(tag)) return false;
    }
    if (q) {
      const hay = `${s.name} ${s.country} ${s.tags} ${s.language}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'bitrate') return (b.bitrate || 0) - (a.bitrate || 0);
    if (sort === 'votes') return (b.votes || 0) - (a.votes || 0);
    if (sort === 'health') return (b._healthScore || healthScore(b)) - (a._healthScore || healthScore(a));
    // Default: health-aware popularity
    const scoreA = (a._healthScore != null) ? a._healthScore : healthScore(a);
    const scoreB = (b._healthScore != null) ? b._healthScore : healthScore(b);
    return scoreB - scoreA;
  });

  return filtered;
}

function renderStations() {
  const list = getFilteredStations();
  stationCount.textContent = `${list.length} stations`;

  if (list.length === 0) {
    stationGrid.innerHTML = '';
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;

  stationGrid.innerHTML = list.map(s => {
    const isCurrent = currentStation && currentStation.stationuuid === s.stationuuid;
    const favicon = s.favicon && s.favicon.startsWith('http') ? s.favicon : '';
    const tags = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 3);
    const health = getHealth(s.stationuuid);
    let healthBadge = '';
    if (health.status === 'ok') {
      healthBadge = '<span class="health-badge ok" title="Verified working">✓</span>';
    } else if (health.status === 'suspect') {
      healthBadge = '<span class="health-badge suspect" title="Previously failed once">!</span>';
    } else if (s.lastcheckok === 1) {
      healthBadge = '<span class="health-badge remote" title="Checked OK by Radio Browser">●</span>';
    }

    return `
      <article class="station-card ${isCurrent && isPlaying ? 'playing' : ''}" data-uuid="${s.stationuuid}">
        <div class="play-indicator"></div>
        ${healthBadge}
        ${favicon
          ? `<img class="station-favicon" src="${favicon}" alt="" loading="lazy" onerror="this.classList.add('fallback');this.src='';this.outerHTML='<div class=\\'station-favicon fallback\\'>📻</div>'">`
          : `<div class="station-favicon fallback">📻</div>`
        }
        <div class="station-info">
          <div class="station-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
          <div class="station-meta">
            ${s.country ? `<span>${escapeHtml(s.country)}</span>` : ''}
            ${s.bitrate ? `<span>${s.bitrate} kbps</span>` : ''}
            ${s.codec ? `<span>${escapeHtml(s.codec)}</span>` : ''}
          </div>
          ${tags.length ? `<div class="station-tags">${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        </div>
      </article>
    `;
  }).join('');

  // Click handlers
  stationGrid.querySelectorAll('.station-card').forEach(card => {
    card.addEventListener('click', () => {
      const uuid = card.dataset.uuid;
      const station = stations.find(s => s.stationuuid === uuid);
      if (station) playStation(station);
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Real-time Buffer / Stream Stats Monitor ----------
const READY_STATE_LABELS = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
const NETWORK_STATE_LABELS = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];

function getBufferedAhead() {
  const a = audioPlayer;
  if (!a.buffered || a.buffered.length === 0) return 0;
  // Find the range that contains (or is ahead of) currentTime
  let end = 0;
  for (let i = 0; i < a.buffered.length; i++) {
    if (a.buffered.start(i) <= a.currentTime + 0.5) {
      end = Math.max(end, a.buffered.end(i));
    }
  }
  if (end === 0 && a.buffered.length > 0) {
    end = a.buffered.end(a.buffered.length - 1);
  }
  return Math.max(0, end - a.currentTime);
}

function updateBufferStats() {
  if (!bufBarFill || !currentStation) return;
  try {
  const ahead = getBufferedAhead();
  const ready = audioPlayer.readyState;
  const net = audioPlayer.networkState;
  const paused = audioPlayer.paused;
  const ended = audioPlayer.ended;

  // Buffer bar: map 0–12s to 0–100% (typical live radio buffer)
  const pct = Math.min(100, (ahead / 12) * 100);
  bufBarFill.style.width = pct + '%';
  bufBarFill.classList.remove('low', 'critical', 'stalled');

  // State label
  let state = 'playing';
  let stateClass = 'playing';

  if (ended) {
    state = 'ended';
    stateClass = 'ended';
  } else if (paused && !isPlaying) {
    state = 'paused';
    stateClass = 'paused';
  } else if (ready < 3 || (ahead < 0.4 && isPlaying)) {
    state = ahead < 0.15 ? 'stalled' : 'buffering';
    stateClass = state;
    if (state === 'stalled') {
      bufBarFill.classList.add('stalled');
      stallCount++;
    } else {
      bufBarFill.classList.add(ahead < 1.5 ? 'critical' : 'low');
    }
  } else if (ahead < 2) {
    bufBarFill.classList.add('low');
  }

  bufStateEl.textContent = state;
  bufStateEl.className = stateClass;

  // Buffered time
  const bufStr = ahead >= 10
    ? `buf ${ahead.toFixed(0)}s`
    : `buf ${ahead.toFixed(1)}s`;
  bufBufferedEl.textContent = bufStr;

  // Ready state (short)
  const readyShort = ['none', 'meta', 'current', 'future', 'enough'][ready] || String(ready);
  bufReadyEl.textContent = `ready ${readyShort}`;

  // Network state + transport
  const se = StreamEngine.getStats();
  if (bufTransportEl) {
    if (se.transport === 'websocket') {
      const wsLabel = ['ws:connecting', 'ws:open', 'ws:closing', 'ws:closed'][se.wsState] || 'ws';
      bufTransportEl.textContent = wsLabel;
      bufTransportEl.title = `WebSocket · ${se.bytesReceived} bytes · queue ${se.queueLength}`;
    } else {
      bufTransportEl.textContent = 'http';
      bufTransportEl.title = 'HTTP progressive stream';
    }
  }

  const netShort = se.transport === 'websocket'
    ? (se.wsState === 1 ? 'ws-live' : 'ws-wait')
    : (['empty', 'idle', 'loading', 'nosrc'][net] || String(net));
  bufNetEl.textContent = `net ${netShort}`;

  // Track progress of buffer growth (for diagnostics)
  const currentEnd = audioPlayer.buffered.length
    ? audioPlayer.buffered.end(audioPlayer.buffered.length - 1)
    : 0;
  lastBufferedEnd = currentEnd;
  } catch (e) {
    // Never let the monitor crash the player
    console.warn('updateBufferStats error:', e);
  }
}

function startBufferMonitor() {
  stopBufferMonitor();
  stallCount = 0;
  lastBufferedEnd = 0;
  updateBufferStats();
  bufferMonitorId = setInterval(updateBufferStats, 400);
}

function stopBufferMonitor() {
  if (bufferMonitorId) {
    clearInterval(bufferMonitorId);
    bufferMonitorId = null;
  }
  if (bufBarFill) {
    bufBarFill.style.width = '0%';
    bufBarFill.classList.remove('low', 'critical', 'stalled');
  }
  if (bufStateEl) {
    bufStateEl.textContent = '—';
    bufStateEl.className = '';
  }
  if (bufBufferedEl) bufBufferedEl.textContent = 'buf 0s';
  if (bufReadyEl) bufReadyEl.textContent = 'ready —';
  if (bufNetEl) bufNetEl.textContent = 'net —';
  if (bufTransportEl) {
    bufTransportEl.textContent = 'http';
    bufTransportEl.title = '';
  }
}

// ============================================================
// StreamEngine — HTTP audio + WebSocket binary streaming
// ============================================================
const StreamEngine = (() => {
  let ws = null;
  let mediaSource = null;
  let sourceBuffer = null;
  let objectUrl = null;
  let queue = [];
  let appending = false;
  let closed = true;
  let bytesReceived = 0;
  let lastChunkAt = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let currentWsUrl = null;
  let onState = null;

  function emit(state, detail) {
    if (typeof onState !== 'function') return;
    try {
      onState(state, detail);
    } catch (e) {
      console.warn('StreamEngine onState handler error:', e);
    }
  }

  function isWebSocketUrl(url) {
    return typeof url === 'string' && /^wss?:\/\//i.test(url);
  }

  function guessMime(station) {
    const codec = ((station && station.codec) || '').toLowerCase();
    if (codec.includes('aac')) return 'audio/aac';
    if (codec.includes('ogg') || codec.includes('vorbis') || codec.includes('opus')) return 'audio/webm; codecs="opus"';
    // Most Icecast/Shoutcast WS bridges send MPEG frames
    return 'audio/mpeg';
  }

  function detachMediaSource() {
    try {
      if (sourceBuffer) {
        sourceBuffer.onupdateend = null;
        sourceBuffer.onerror = null;
      }
      if (mediaSource && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    sourceBuffer = null;
    mediaSource = null;
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (_) { /* ignore */ }
      objectUrl = null;
    }
  }

  function flushQueue() {
    if (!sourceBuffer || appending || !queue.length) return;
    if (sourceBuffer.updating) return;
    appending = true;
    const chunk = queue.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      appending = false;
      console.warn('SourceBuffer append failed:', e);
      // Drop buffer and continue
      if (queue.length > 40) queue = queue.slice(-10);
      emit('error', e);
    }
  }

  function attachMediaSource(station) {
    return new Promise((resolve, reject) => {
      if (!window.MediaSource) {
        reject(ErrorHandler.AppError('MSE_UNSUPPORTED', 'MediaSource Extensions not supported'));
        return;
      }
      detachMediaSource();
      mediaSource = new MediaSource();
      objectUrl = URL.createObjectURL(mediaSource);
      audioPlayer.src = objectUrl;

      mediaSource.addEventListener('sourceopen', () => {
        try {
          const mime = guessMime(station);
          if (!MediaSource.isTypeSupported(mime)) {
            // Fallback mime
            const fallback = 'audio/mpeg';
            if (!MediaSource.isTypeSupported(fallback)) {
              reject(ErrorHandler.AppError('MSE_CODEC', 'No supported MSE audio codec'));
              return;
            }
            sourceBuffer = mediaSource.addSourceBuffer(fallback);
          } else {
            sourceBuffer = mediaSource.addSourceBuffer(mime);
          }
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', () => {
            appending = false;
            flushQueue();
          });
          sourceBuffer.addEventListener('error', (e) => emit('error', e));
          resolve();
        } catch (e) {
          reject(e);
        }
      }, { once: true });

      mediaSource.addEventListener('error', (e) => reject(e), { once: true });
    });
  }

  function handleWsMessage(event) {
    try {
      lastChunkAt = Date.now();
      const data = event.data;
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg && msg.type === 'metadata') emit('metadata', msg);
        } catch (_) { /* plain text — ignore */ }
        return;
      }
      if (data instanceof Blob) {
        data.arrayBuffer().then(buf => {
          if (closed) return;
          bytesReceived += buf.byteLength;
          queue.push(buf);
          if (queue.length > 60) queue = queue.slice(-30);
          flushQueue();
          emit('chunk', { bytes: buf.byteLength, total: bytesReceived });
        }).catch(e => {
          console.warn('WS Blob read failed:', e);
        });
        return;
      }
      if (data instanceof ArrayBuffer) {
        bytesReceived += data.byteLength;
        queue.push(data);
        if (queue.length > 60) queue = queue.slice(-30);
        flushQueue();
        emit('chunk', { bytes: data.byteLength, total: bytesReceived });
      }
    } catch (e) {
      console.warn('WS message handler error:', e);
      emit('error', ErrorHandler.fromUnknown(e));
    }
  }

  function scheduleReconnect(station) {
    if (closed || !currentWsUrl) return;
    if (reconnectAttempts >= 5) {
      emit('failed', ErrorHandler.AppError('WS_RECONNECT', 'WebSocket reconnect limit reached'));
      return;
    }
    const wait = Math.min(8000, 500 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    emit('reconnecting', { attempt: reconnectAttempts, wait });
    reconnectTimer = setTimeout(() => {
      openWebSocket(currentWsUrl, station).catch(err => emit('failed', err));
    }, wait);
  }

  function openWebSocket(url, station) {
    return new Promise(async (resolve, reject) => {
      try {
        await attachMediaSource(station);
      } catch (e) {
        reject(e);
        return;
      }

      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(ErrorHandler.AppError('WS_OPEN', 'Could not open WebSocket', e));
        return;
      }
      ws.binaryType = 'arraybuffer';

      const openTimer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        reject(ErrorHandler.AppError('WS_TIMEOUT', 'WebSocket connection timed out'));
      }, 12000);

      ws.onopen = () => {
        clearTimeout(openTimer);
        reconnectAttempts = 0;
        closed = false;
        activeTransport = 'websocket';
        emit('open', { url });
        // Start playback once some data may arrive
        audioPlayer.play().catch(() => {});
        resolve();
      };

      ws.onmessage = handleWsMessage;

      ws.onerror = () => {
        clearTimeout(openTimer);
        emit('error', ErrorHandler.AppError('WS_ERROR', 'WebSocket error'));
      };

      ws.onclose = () => {
        clearTimeout(openTimer);
        ws = null;
        emit('close');
        if (!closed) scheduleReconnect(station);
      };
    });
  }

  function stop() {
    closed = true;
    currentWsUrl = null;
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close(1000, 'stop');
      } catch (_) { /* ignore */ }
      ws = null;
    }
    queue = [];
    appending = false;
    bytesReceived = 0;
    detachMediaSource();
    activeTransport = 'http';
    emit('stop');
  }

  /**
   * Start streaming. Uses WebSocket + MSE when URL is ws(s)://
   * Returns { transport: 'websocket'|'http', promise }
   */
  async function start(station, url, handlers = {}) {
    stop();
    onState = handlers.onState || null;
    closed = false;
    bytesReceived = 0;
    lastChunkAt = 0;

    const urlErr = ErrorHandler.validateStreamUrl(url);
    if (urlErr) throw urlErr;

    if (isWebSocketUrl(url)) {
      currentWsUrl = url;
      activeTransport = 'websocket';
      try {
        await openWebSocket(url, station);
        return { transport: 'websocket' };
      } catch (e) {
        stop();
        throw ErrorHandler.fromUnknown(e);
      }
    }

    // Standard HTTP(S) progressive stream via <audio>
    activeTransport = 'http';
    currentWsUrl = null;
    try {
      audioPlayer.src = url;
      audioPlayer.load();
      await audioPlayer.play();
      return { transport: 'http' };
    } catch (e) {
      throw ErrorHandler.fromUnknown(e);
    }
  }

  function getStats() {
    return {
      transport: activeTransport,
      wsState: ws ? ws.readyState : null, // 0 CONNECTING 1 OPEN 2 CLOSING 3 CLOSED
      bytesReceived,
      queueLength: queue.length,
      lastChunkAgeMs: lastChunkAt ? Date.now() - lastChunkAt : null,
      reconnectAttempts
    };
  }

  return { start, stop, getStats, isWebSocketUrl };
})();

// ---------- Player ----------
function handlePlaybackFailure(station, err) {
  const msg = ErrorHandler.messageOf(err) || 'Stream unavailable — try another station';
  console.error('Playback failure:', station && station.name, msg, err);

  if (station) {
    markUnhealthy(station.stationuuid);
    station._healthScore = healthScore(station);
  }
  if (npMeta) npMeta.textContent = msg;
  isPlaying = false;
  updatePlayUI();
  ErrorHandler.toast(msg, 'error', 4000);

  if (station && getHealth(station.stationuuid).status === 'dead') {
    setTimeout(() => renderStations(), 600);
  } else {
    renderStations();
  }
}

function tryPlayUrl(station, url) {
  return new Promise(async (resolve, reject) => {
    const urlErr = ErrorHandler.validateStreamUrl(url);
    if (urlErr) {
      reject(urlErr);
      return;
    }

    audioPlayer.onerror = null;
    audioPlayer.onplaying = null;

    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      fn(value);
    };

    const failTimer = setTimeout(() => {
      settle(reject)(ErrorHandler.AppError('STREAM_TIMEOUT', 'Stream took too long to start'));
    }, 15000);

    audioPlayer.onplaying = settle(() => {
      try {
        markHealthy(station.stationuuid);
        station._healthScore = healthScore(station);
      } catch (_) { /* ignore */ }
      resolve();
    });

    audioPlayer.onerror = settle(() => {
      reject(ErrorHandler.fromMedia(audioPlayer));
    });

    try {
      const result = await StreamEngine.start(station, url, {
        onState: (state, detail) => {
          try {
            if (state === 'open') {
              if (bufTransportEl) bufTransportEl.textContent = 'ws';
              ErrorHandler.toast('WebSocket stream connected', 'success', 2000);
            } else if (state === 'reconnecting') {
              if (npMeta) npMeta.textContent = `WebSocket reconnecting (${detail.attempt})…`;
            } else if (state === 'failed') {
              settle(reject)(detail || ErrorHandler.AppError('WS_FAILED', 'WebSocket stream failed'));
            } else if (state === 'error' && detail) {
              console.warn('StreamEngine error event:', detail);
            } else if (state === 'metadata' && detail && detail.title) {
              if (npMeta) npMeta.textContent = detail.title;
            }
          } catch (e) {
            console.warn('onState UI update failed:', e);
          }
        }
      });

      if (result.transport === 'websocket') {
        if (bufTransportEl) bufTransportEl.textContent = 'ws';
        activeTransport = 'websocket';
        setTimeout(() => {
          if (!settled) settle(resolve)();
        }, 1500);
        return;
      }

      activeTransport = 'http';
      if (bufTransportEl) bufTransportEl.textContent = 'http';
      // HTTP: wait for onplaying / timeout / onerror
    } catch (e) {
      const appErr = ErrorHandler.fromUnknown(e);
      if (appErr.code === 'AUTOPLAY') {
        ErrorHandler.toast(ErrorHandler.messageOf(appErr), 'info', 3500);
        settle(resolve)();
        return;
      }
      if (StreamEngine.isWebSocketUrl(url)) {
        settle(reject)(appErr);
        return;
      }
      // Classic HTTP fallback if StreamEngine path threw
      try {
        audioPlayer.src = url;
        audioPlayer.load();
        await audioPlayer.play();
        // success path waits for onplaying
      } catch (err) {
        const normalized = ErrorHandler.fromUnknown(err);
        if (normalized.code === 'AUTOPLAY') {
          ErrorHandler.toast(ErrorHandler.messageOf(normalized), 'info', 3500);
          settle(resolve)();
          return;
        }
        settle(reject)(normalized);
      }
    }
  });
}

async function playStation(station) {
  if (!station) {
    ErrorHandler.toast('No station selected', 'error');
    return;
  }
  if (!ErrorHandler.requireOnline('Playback')) return;
  if (!station.stationuuid) {
    ErrorHandler.toast('Invalid station data', 'error');
    return;
  }

  try {
    StreamEngine.stop();
  } catch (e) {
    console.warn('StreamEngine.stop during playStation:', e);
  }

  currentStation = station;
  const primary = station.url_resolved || station.url;
  const fallback = (station.url && station.url !== primary) ? station.url : null;
  const wsUrl = station.ws_url || station.websocket || null;

  fetchJson(`/json/url/${station.stationuuid}`).catch(() => {});

  try {
    npName.textContent = station.name || 'Unknown';
    npMeta.textContent = [station.country, station.bitrate ? `${station.bitrate} kbps` : '', station.codec]
      .filter(Boolean).join(' · ');
    npImg.src = station.favicon || '';
    npImg.onerror = () => { npImg.src = ''; };
    nowPlaying.hidden = false;
    updateFavUI();
    startBufferMonitor();
  } catch (e) {
    console.warn('UI setup for playback failed:', e);
  }

  const urlsToTry = [];
  if (wsUrl && StreamEngine.isWebSocketUrl(wsUrl)) urlsToTry.push(wsUrl);
  if (primary) urlsToTry.push(primary);
  if (fallback) urlsToTry.push(fallback);

  if (!urlsToTry.length) {
    handlePlaybackFailure(station, ErrorHandler.AppError('BAD_URL', 'Station has no playable stream URL'));
    return;
  }

  let lastErr = null;
  for (let i = 0; i < urlsToTry.length; i++) {
    const url = urlsToTry[i];
    const bad = ErrorHandler.validateStreamUrl(url);
    if (bad && bad.code === 'BAD_URL') {
      lastErr = bad;
      continue;
    }
    try {
      if (i > 0) {
        if (npMeta) {
          npMeta.textContent = StreamEngine.isWebSocketUrl(url)
            ? 'Trying WebSocket stream…'
            : 'Trying alternate stream URL…';
        }
        try { StreamEngine.stop(); } catch (_) { /* ignore */ }
      }
      await tryPlayUrl(station, url);
      isPlaying = true;
      updatePlayUI();
      renderStations();
      setTimeout(() => {
        try {
          if (isPlaying && currentStation && currentStation.stationuuid === station.stationuuid) {
            markHealthy(station.stationuuid);
          }
        } catch (_) { /* ignore */ }
      }, 2500);
      return;
    } catch (err) {
      lastErr = ErrorHandler.fromUnknown(err);
      console.warn('Stream attempt failed:', url, lastErr);
    }
  }
  handlePlaybackFailure(station, lastErr);
}

function togglePlay() {
  if (!currentStation) return;
  try {
    if (isPlaying) {
      audioPlayer.pause();
      isPlaying = false;
    } else {
      audioPlayer.play()
        .then(() => { isPlaying = true; updatePlayUI(); })
        .catch(err => {
          const appErr = ErrorHandler.fromUnknown(err);
          if (appErr.code === 'AUTOPLAY') {
            ErrorHandler.toast(ErrorHandler.messageOf(appErr), 'info', 3000);
          } else {
            ErrorHandler.toast(ErrorHandler.messageOf(appErr), 'error', 3500);
          }
          isPlaying = false;
          updatePlayUI();
        });
    }
    updatePlayUI();
    renderStations();
  } catch (e) {
    console.error('togglePlay failed:', e);
    ErrorHandler.toast('Playback control failed', 'error');
  }
}

function stopPlayback() {
  try {
    StreamEngine.stop();
  } catch (e) {
    console.warn('StreamEngine.stop failed:', e);
  }
  try {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
  } catch (e) {
    console.warn('audio reset failed:', e);
  }
  isPlaying = false;
  currentStation = null;
  nowPlaying.hidden = true;
  activeTransport = 'http';
  stopBufferMonitor();
  updatePlayUI();
  renderStations();
}

function updatePlayUI() {
  playIcon.hidden = isPlaying;
  pauseIcon.hidden = !isPlaying;
  eqBars.classList.toggle('active', isPlaying);
}

function toggleFavorite() {
  if (!currentStation) return;
  const uuid = currentStation.stationuuid;
  const idx = favorites.indexOf(uuid);
  if (idx >= 0) {
    favorites.splice(idx, 1);
  } else {
    favorites.push(uuid);
  }
  safeLocalStorageSet('ai-radio-favs', favorites);
  updateFavUI();
}

function updateFavUI() {
  const isFav = currentStation && favorites.includes(currentStation.stationuuid);
  favOutline.hidden = isFav;
  favFilled.hidden = !isFav;
  favBtn.classList.toggle('active', isFav);
}

// ---------- Events ----------
updateBtn.addEventListener('click', () => {
  if (!ErrorHandler.requireOnline('Updating stations')) return;
  loadStations(true);
});

searchInput.addEventListener('input', () => {
  clearSearch.hidden = !searchInput.value;
  renderStations();
});

clearSearch.addEventListener('click', () => {
  searchInput.value = '';
  clearSearch.hidden = true;
  renderStations();
});

countryFilter.addEventListener('change', renderStations);
tagFilter.addEventListener('change', renderStations);
sortFilter.addEventListener('change', renderStations);

playPauseBtn.addEventListener('click', () => {
  try {
    togglePlay();
  } catch (e) {
    console.error('togglePlay error:', e);
    ErrorHandler.toast('Playback control failed', 'error');
  }
});
stopBtn.addEventListener('click', stopPlayback);
favBtn.addEventListener('click', toggleFavorite);

const toastCloseBtn = document.getElementById('toastClose');
if (toastCloseBtn) toastCloseBtn.addEventListener('click', ErrorHandler.hideToast);

audioPlayer.addEventListener('play', () => {
  isPlaying = true;
  updatePlayUI();
  if (currentStation) markHealthy(currentStation.stationuuid);
  updateBufferStats();
});
audioPlayer.addEventListener('playing', () => updateBufferStats());
audioPlayer.addEventListener('waiting', () => updateBufferStats());
audioPlayer.addEventListener('stalled', () => {
  updateBufferStats();
  if (stallCount > 8 && currentStation) {
    ErrorHandler.toast('Stream is stalling — weak connection or overloaded server', 'info', 3500);
    stallCount = 0;
  }
});
audioPlayer.addEventListener('progress', () => updateBufferStats());
audioPlayer.addEventListener('canplay', () => updateBufferStats());
audioPlayer.addEventListener('canplaythrough', () => updateBufferStats());
audioPlayer.addEventListener('pause', () => {
  isPlaying = false;
  updateBufferStats();
  updatePlayUI();
});
audioPlayer.addEventListener('error', () => {
  isPlaying = false;
  updatePlayUI();
  if (currentStation) {
    handlePlaybackFailure(currentStation, ErrorHandler.fromMedia(audioPlayer));
  }
});

window.addEventListener('online', () => {
  ErrorHandler.setOnline(true);
  ErrorHandler.toast('Back online', 'success', 2500);
});
window.addEventListener('offline', () => {
  ErrorHandler.setOnline(false);
  ErrorHandler.toast('You are offline — streams and updates unavailable', 'error', 5000);
  if (isPlaying) updateBufferStats();
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
});
window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error || e.message);
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    try { togglePlay(); } catch (_) { /* ignore */ }
  }
});

// ---------- Init ----------
favorites = ErrorHandler.storageGet('ai-radio-favs', []);
healthCache = ErrorHandler.storageGet('ai-radio-health', {});
if (!Array.isArray(favorites)) favorites = [];
if (!healthCache || typeof healthCache !== 'object') healthCache = {};

if (!isOnline) {
  ErrorHandler.toast('You are offline — connect to load stations', 'error', 5000);
}

loadStations(false);
