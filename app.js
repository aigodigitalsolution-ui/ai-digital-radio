/**
 * AI Digital Radio — Worldwide stations via Radio Browser API
 * AI Agent "updates" the station list by fetching live data
 */

const API_BASES = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://all.api.radio-browser.info'
];

let currentApi = API_BASES[0];
let stations = [];
let currentStation = null;
let favorites = JSON.parse(localStorage.getItem('ai-radio-favs') || '[]');
let isPlaying = false;

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

// ---------- API helpers ----------
async function fetchJson(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `${currentApi}${path}${query ? '?' + query : ''}`;

  for (let i = 0; i < API_BASES.length; i++) {
    try {
      const res = await fetch(url.replace(currentApi, API_BASES[i]), {
        headers: { 'User-Agent': 'AI-Digital-Radio/1.0' }
      });
      if (res.ok) {
        currentApi = API_BASES[i];
        return await res.json();
      }
    } catch (e) {
      console.warn('API mirror failed:', API_BASES[i], e);
    }
  }
  throw new Error('All Radio Browser API mirrors failed');
}

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
        // Skip stations known to be broken
        if (s.lastcheckok === 0) return;
        map.set(s.stationuuid, s);
      }
    });
  };

  try {
    // Phase 1 – Global popularity ranking
    if (isUpdate) showAiStatus('Phase 1/4 · Ranking most-clicked & most-voted stations worldwide...');
    const [byClicks, byVotes, byLastClick] = await Promise.all([
      fetchJson('/json/stations/topclick/250'),
      fetchJson('/json/stations/topvote/200'),
      fetchJson('/json/stations/lastclick/150')
    ]);
    addStations(byClicks);
    addStations(byVotes);
    addStations(byLastClick);

    // Phase 2 – Genre deep-dive (batched to be friendly to the public API)
    if (isUpdate) showAiStatus('Phase 2/4 · Exploring 30+ popular genres & formats...');
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
    if (isUpdate) showAiStatus('Phase 3/4 · Scanning major countries on every continent...');
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
    if (isUpdate) showAiStatus('Phase 4/4 · Collecting high-bitrate & recent streams...');
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

    stations = Array.from(map.values());

    // Prefer higher popularity when presenting
    stations.sort((a, b) => (b.clickcount || 0) - (a.clickcount || 0));

    // Cap for UI performance while keeping a rich catalogue
    if (stations.length > 1400) {
      stations = stations.slice(0, 1400);
    }

    populateFilters(stations);
    renderStations();

    const now = new Date();
    lastUpdated.textContent = isUpdate
      ? `AI Agent updated · ${stations.length} stations · ${now.toLocaleTimeString()}`
      : `Loaded · ${stations.length} stations · ${now.toLocaleTimeString()}`;
    stationCount.textContent = `${stations.length} stations`;

    if (isUpdate) {
      showAiStatus(`✅ AI Agent complete! Discovered ${stations.length} working stations worldwide.`);
      setTimeout(hideAiStatus, 3200);
    }
  } catch (err) {
    console.error(err);
    stationGrid.innerHTML = '';
    emptyState.hidden = false;
    emptyState.querySelector('h3').textContent = 'Connection error';
    emptyState.querySelector('p').textContent = 'Could not reach Radio Browser API. Check your internet and try Update again.';
    lastUpdated.textContent = 'Failed to load';
    if (isUpdate) {
      showAiStatus('❌ AI Agent could not reach the network. Try again.');
      setTimeout(hideAiStatus, 3500);
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
    // clickcount default
    return (b.clickcount || 0) - (a.clickcount || 0);
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

    return `
      <article class="station-card ${isCurrent && isPlaying ? 'playing' : ''}" data-uuid="${s.stationuuid}">
        <div class="play-indicator"></div>
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

// ---------- Player ----------
function playStation(station) {
  currentStation = station;
  const url = station.url_resolved || station.url;

  // Click count (best effort, non-blocking)
  fetchJson(`/json/url/${station.stationuuid}`).catch(() => {});

  npName.textContent = station.name || 'Unknown';
  npMeta.textContent = [station.country, station.bitrate ? `${station.bitrate} kbps` : '', station.codec]
    .filter(Boolean).join(' · ');
  npImg.src = station.favicon || '';
  npImg.onerror = () => { npImg.src = ''; };

  nowPlaying.hidden = false;
  updateFavUI();

  audioPlayer.src = url;
  audioPlayer.play()
    .then(() => {
      isPlaying = true;
      updatePlayUI();
      renderStations(); // highlight
    })
    .catch(err => {
      console.error('Playback error:', err);
      npMeta.textContent = 'Stream unavailable — try another station';
      isPlaying = false;
      updatePlayUI();
    });
}

function togglePlay() {
  if (!currentStation) return;
  if (isPlaying) {
    audioPlayer.pause();
    isPlaying = false;
  } else {
    audioPlayer.play().then(() => { isPlaying = true; }).catch(() => {});
  }
  updatePlayUI();
  renderStations();
}

function stopPlayback() {
  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  isPlaying = false;
  currentStation = null;
  nowPlaying.hidden = true;
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
  localStorage.setItem('ai-radio-favs', JSON.stringify(favorites));
  updateFavUI();
}

function updateFavUI() {
  const isFav = currentStation && favorites.includes(currentStation.stationuuid);
  favOutline.hidden = isFav;
  favFilled.hidden = !isFav;
  favBtn.classList.toggle('active', isFav);
}

// ---------- Events ----------
updateBtn.addEventListener('click', () => loadStations(true));

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

playPauseBtn.addEventListener('click', togglePlay);
stopBtn.addEventListener('click', stopPlayback);
favBtn.addEventListener('click', toggleFavorite);

audioPlayer.addEventListener('play', () => {
  isPlaying = true;
  updatePlayUI();
});
audioPlayer.addEventListener('pause', () => {
  isPlaying = false;
  updatePlayUI();
});
audioPlayer.addEventListener('error', () => {
  isPlaying = false;
  updatePlayUI();
  if (currentStation) {
    npMeta.textContent = 'Stream error — try another station';
  }
});

// Keyboard: space to play/pause when focused elsewhere
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    togglePlay();
  }
});

// ---------- Init ----------
loadStations(false);
