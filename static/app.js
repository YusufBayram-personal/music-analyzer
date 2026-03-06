/* ── Utility ──────────────────────────────────────────────────────────── */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function showLoader(on) {
  $('#loader').classList.toggle('show', on);
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n;
}

/* ── Tab routing ──────────────────────────────────────────────────────── */
const tabLoaded = {};

$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.tab-content').forEach(s => s.classList.add('hidden'));
    $(`#tab-${tab}`).classList.remove('hidden');
    if (!tabLoaded[tab]) { tabLoaded[tab] = true; loadTab(tab); }
  });
});

async function loadTab(tab) {
  showLoader(true);
  try {
    switch (tab) {
      case 'heatmap':    await loadHeatmap(); break;
      case 'toptracks':  await loadTopTracks('short_term'); break;
      case 'topartists': await loadTopArtists('short_term'); break;
      case 'audio':      await loadAudioFeatures(); break;
      case 'genres':     await loadGenres('short_term'); break;
    }
  } catch (e) { console.error(e); }
  showLoader(false);
}

/* ── Bootstrap Overview (always loads) ───────────────────────────────── */
async function initDashboard() {
  showLoader(true);
  tabLoaded['overview'] = true;
  try {
    const [profile, streak, recent, heatmapData, genres] = await Promise.all([
      api('/api/profile'),
      api('/api/listening_streak'),
      api('/api/recent'),
      api('/api/weekly_heatmap'),
      api('/api/genre_breakdown'),
    ]);

    // Profile chip
    const chip = $('#profile-chip');
    chip.classList.remove('hidden');
    $('#username').textContent = profile.display_name || profile.id;
    if (profile.images?.[0]) $('#avatar').src = profile.images[0].url;

    // Stats
    $('#streak-val').textContent = streak.streak;
    $('#days-val').textContent = streak.active_days;
    $('#plays-val').textContent = streak.total_plays;
    $('#top-genre-val').textContent = genres[0]?.genre || '—';

    // Hourly chart (built from heatmap data aggregated by hour)
    buildHourlyChart(heatmapData);

    // Recent tracks
    buildRecentList(recent.items?.slice(0, 10) || []);

  } catch (e) { console.error(e); }
  showLoader(false);
}

/* ── Hourly Activity Chart ────────────────────────────────────────────── */
function buildHourlyChart(heatmapData) {
  const hours = Array(24).fill(0);
  heatmapData.forEach(({ hour, count }) => { hours[hour] += count; });
  const labels = hours.map((_, h) => h % 6 === 0 ? `${h}:00` : '');
  const ctx = $('#hourly-chart').getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Array.from({ length: 24 }, (_, h) => `${h}:00`),
      datasets: [{
        label: 'Plays',
        data: hours,
        backgroundColor: hours.map(v => v > 0 ? 'rgba(29,185,84,0.7)' : 'rgba(29,185,84,0.15)'),
        borderRadius: 4,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: t => `${t[0].label}` } }
      },
      scales: {
        x: {
          ticks: { color: '#7a7a9a', font: { size: 10 }, maxRotation: 0,
            callback(val, i) { return i % 6 === 0 ? this.getLabelForValue(i) : ''; }
          },
          grid: { color: 'rgba(255,255,255,.05)' }
        },
        y: { ticks: { color: '#7a7a9a', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.05)' } }
      }
    }
  });
}

/* ── Recent Track List ────────────────────────────────────────────────── */
function buildRecentList(items) {
  const ul = $('#recent-list');
  ul.innerHTML = items.map((item, i) => {
    const t = item.track;
    const img = t.album?.images?.[0]?.url || '';
    return `<li>
      <span class="track-num">${i + 1}</span>
      ${img ? `<img class="track-img" src="${img}" alt="" />` : '<div class="track-img"></div>'}
      <div class="track-info">
        <div class="track-name">${esc(t.name)}</div>
        <div class="track-artist">${esc(t.artists.map(a => a.name).join(', '))}</div>
      </div>
    </li>`;
  }).join('');
}

/* ── Heatmap ──────────────────────────────────────────────────────────── */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function loadHeatmap() {
  const data = await api('/api/weekly_heatmap');

  // Build hour axis labels
  const xLabels = $('#heatmap-x-labels');
  xLabels.innerHTML = Array.from({ length: 24 }, (_, h) =>
    `<span>${h % 6 === 0 ? h : ''}</span>`
  ).join('');

  const grid = $('#heatmap-grid');
  grid.innerHTML = '';

  // Index data
  const map = {};
  let maxCount = 1;
  data.forEach(({ day, hour, count, tracks }) => {
    map[`${day}-${hour}`] = { count, tracks };
    if (count > maxCount) maxCount = count;
  });

  const tooltip = $('#heatmap-tooltip');

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const entry = map[`${day}-${hour}`];
      const count = entry?.count || 0;
      const ratio = count / maxCount;
      const size = count > 0 ? Math.max(8, Math.round(ratio * 24)) : 4;
      const opacity = count > 0 ? 0.15 + ratio * 0.85 : 0.08;

      const cell = document.createElement('div');
      cell.className = 'hm-cell';
      const dot = document.createElement('div');
      dot.className = 'hm-dot';
      dot.style.cssText = `width:${size}px;height:${size}px;opacity:${opacity.toFixed(2)};`;
      cell.appendChild(dot);

      if (count > 0) {
        cell.addEventListener('mousemove', e => {
          tooltip.innerHTML = `<strong>${DAYS[day]} ${String(hour).padStart(2,'0')}:00</strong><br>${count} play${count > 1 ? 's' : ''}<br><em>${(entry.tracks || []).join(', ')}</em>`;
          tooltip.classList.add('show');
          tooltip.style.left = `${e.clientX + 12}px`;
          tooltip.style.top = `${e.clientY + 12}px`;
        });
        cell.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
      }

      grid.appendChild(cell);
    }
  }
}

/* ── Top Tracks ───────────────────────────────────────────────────────── */
async function loadTopTracks(range) {
  const tracks = await api(`/api/top_tracks?time_range=${range}`);
  const grid = $('#tracks-grid');
  grid.innerHTML = tracks.map((t, i) => `
    <div class="track-card">
      ${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy"/>` : '<div style="aspect-ratio:1;background:var(--border);border-radius:8px;"></div>'}
      <div class="card-rank">#${i + 1}</div>
      <div class="card-title">${esc(t.name)}</div>
      <div class="card-sub-text">${esc(t.artist)}</div>
      <div class="popularity-bar"><div class="popularity-fill" style="width:${t.popularity}%"></div></div>
    </div>
  `).join('');
}

// Time-range switcher for tracks
$('#tab-toptracks').addEventListener('click', e => {
  const btn = e.target.closest('.time-btn');
  if (!btn) return;
  $$('#tab-toptracks .time-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showLoader(true);
  loadTopTracks(btn.dataset.range).finally(() => showLoader(false));
});

/* ── Top Artists ──────────────────────────────────────────────────────── */
async function loadTopArtists(range) {
  const artists = await api(`/api/top_artists?time_range=${range}`);
  const grid = $('#artists-grid');
  grid.innerHTML = artists.map((a, i) => `
    <div class="artist-card">
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy"/>` : '<div style="aspect-ratio:1;background:var(--border);border-radius:50%;"></div>'}
      <div class="card-rank">#${i + 1}</div>
      <div class="card-title">${esc(a.name)}</div>
      <div class="genre-tags">${a.genres.map(g => `<span class="genre-tag">${esc(g)}</span>`).join('')}</div>
      <div class="followers">${fmtNum(a.followers)} followers</div>
      <div class="popularity-bar"><div class="popularity-fill" style="width:${a.popularity}%"></div></div>
    </div>
  `).join('');
}

$('#tab-topartists').addEventListener('click', e => {
  const btn = e.target.closest('.time-btn');
  if (!btn) return;
  $$('#tab-topartists .time-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showLoader(true);
  loadTopArtists(btn.dataset.range).finally(() => showLoader(false));
});

/* ── Audio Features ───────────────────────────────────────────────────── */
const FEATURE_META = {
  danceability:     { label: 'Danceability',     desc: 'How suitable for dancing' },
  energy:           { label: 'Energy',           desc: 'Intensity and activity level' },
  valence:          { label: 'Valence',          desc: 'Musical positiveness / happiness' },
  acousticness:     { label: 'Acousticness',     desc: 'Confidence it\'s acoustic' },
  instrumentalness: { label: 'Instrumentalness', desc: 'Predicts no vocal content' },
  liveness:         { label: 'Liveness',         desc: 'Presence of a live audience' },
  speechiness:      { label: 'Speechiness',      desc: 'Presence of spoken words' },
};

let radarChart = null;

async function loadAudioFeatures() {
  const feat = await api('/api/audio_features');
  if (!feat || Object.keys(feat).length === 0) {
    $('#tab-audio').innerHTML += '<p style="color:var(--text-dim);padding:24px;">Not enough data to compute audio features.</p>';
    return;
  }

  const keys = Object.keys(FEATURE_META);
  const values = keys.map(k => feat[k] || 0);

  // Radar
  const ctx = $('#radar-chart').getContext('2d');
  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: keys.map(k => FEATURE_META[k].label),
      datasets: [{
        label: 'Your Profile',
        data: values,
        backgroundColor: 'rgba(29,185,84,0.15)',
        borderColor: '#1DB954',
        pointBackgroundColor: '#1DB954',
        pointBorderColor: '#0a0a0f',
        pointRadius: 4,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      scales: {
        r: {
          min: 0, max: 1,
          ticks: { display: false },
          grid: { color: 'rgba(255,255,255,.1)' },
          angleLines: { color: 'rgba(255,255,255,.1)' },
          pointLabels: { color: '#e8e8f0', font: { size: 12, weight: '600' } }
        }
      },
      plugins: { legend: { display: false } }
    }
  });

  // Feature bars
  const barsEl = $('#feature-bars');
  barsEl.innerHTML = keys.map(k => {
    const val = feat[k] || 0;
    const pct = Math.round(val * 100);
    return `
      <div class="feature-row">
        <div class="feature-label-row">
          <span class="feature-name">${FEATURE_META[k].label}</span>
          <span class="feature-val">${pct}%</span>
        </div>
        <div class="feature-bar-bg">
          <div class="feature-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="feature-desc">${FEATURE_META[k].desc}</div>
      </div>`;
  }).join('');

  // Tempo note
  if (feat.tempo) {
    barsEl.insertAdjacentHTML('beforeend', `
      <div style="margin-top:12px;padding:12px;background:var(--surface2);border-radius:10px;font-size:12px;">
        Avg Tempo: <strong style="color:var(--accent)">${feat.tempo} BPM</strong>
      </div>`);
  }
}

/* ── Genres ───────────────────────────────────────────────────────────── */
let genreChart = null;

async function loadGenres(range = 'short_term') {
  const genres = await api(`/api/genre_breakdown?time_range=${range}`);
  if (!genres.length) return;

  const top = genres.slice(0, 10);
  const maxCount = top[0].count;

  // Doughnut chart
  const ctx = $('#genre-chart').getContext('2d');
  const PALETTE = ['#1DB954','#1ed760','#169c41','#0d6e2e','#a8f0c0','#52d68a',
                   '#2af598','#009efd','#5b34d4','#f7971e'];
  if (genreChart) genreChart.destroy();
  genreChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: top.map(g => g.genre),
      datasets: [{
        data: top.map(g => g.count),
        backgroundColor: PALETTE,
        borderColor: '#12121a',
        borderWidth: 3,
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#e8e8f0', font: { size: 11 }, padding: 14, boxWidth: 12 }
        }
      }
    }
  });

  // Genre list
  const listEl = $('#genre-list');
  listEl.innerHTML = genres.map((g, i) => `
    <div class="genre-row">
      <span class="genre-rank">${i + 1}</span>
      <span class="genre-name">${esc(g.genre)}</span>
      <div class="genre-count-bar">
        <div class="genre-count-fill" style="width:${Math.round((g.count / maxCount) * 100)}%"></div>
      </div>
      <span class="genre-count-label">${g.count}</span>
    </div>
  `).join('');
}

/* ── XSS-safe escape ─────────────────────────────────────────────────── */
function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Init ────────────────────────────────────────────────────────────── */
initDashboard();
