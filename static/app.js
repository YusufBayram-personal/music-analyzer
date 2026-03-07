/* ── Helpers ──────────────────────────────────────────────────────── */
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtNum = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n;

function showLoader(on){ $('#loader').classList.toggle('show', on); }

async function api(path){
  const r = await fetch(path);
  if(r.status === 403){
    const data = await r.json().catch(() => ({}));
    if(data.error === 'forbidden') throw new ForbiddenError(data.msg);
    if(data.error === 'deprecated') throw new DeprecatedError();
  }
  if(!r.ok){
    const errData = await r.json().catch(() => ({}));
    const err = new Error(errData.msg || `${path} → ${r.status}`);
    err.serverMsg = errData.msg || '';
    throw err;
  }
  return r.json();
}

class ForbiddenError extends Error { constructor(msg){ super(msg || 'forbidden'); } }

class DeprecatedError extends Error { constructor(){ super('deprecated'); } }

function deprecatedNotice(containerId){
  const el = document.getElementById(containerId);
  if(el) el.innerHTML = `<div class="deprecated-notice">
    <span class="deprecated-icon">🚫</span>
    <strong>Feature unavailable</strong>
    <p>Spotify removed access to audio analysis data for apps created after November 2024. This feature is no longer available.</p>
  </div>`;
}

/* ── Animated counter ─────────────────────────────────────────────── */
function animCount(el, target, duration = 700){
  const start = Date.now();
  const tick = () => {
    const p = Math.min((Date.now()-start)/duration, 1);
    const val = Math.round(p * p * target);   // ease-in quad
    el.textContent = val;
    if(p < 1) requestAnimationFrame(tick);
  };
  tick();
}

/* ── Chart defaults ───────────────────────────────────────────────── */
Chart.defaults.color = '#6b6b8a';
Chart.defaults.borderColor = 'rgba(255,255,255,.06)';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";

const PALETTE = ['#1DB954','#1ed760','#169c41','#a8f0c0','#52d68a',
                 '#8b5cf6','#3b82f6','#f59e0b','#ef4444','#ec4899',
                 '#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6'];

/* ── Tab routing ──────────────────────────────────────────────────── */
const loaded = {};
$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.tab-content').forEach(s => s.classList.add('hidden'));
    $(`#tab-${tab}`).classList.remove('hidden');
    if(!loaded[tab]){ loaded[tab]=true; loadTab(tab); }
  });
});

async function loadTab(tab){
  showLoader(true);
  try {
    switch(tab){
      case 'personality': await loadPersonality(); break;
      case 'heatmap':     await loadHeatmap(); break;
      case 'toptracks':   await loadTopTracks('short_term'); break;
      case 'topartists':  await loadTopArtists('short_term'); break;
      case 'audio':       await loadAudio(); break;
      case 'genres':      await loadGenres('short_term'); break;
      case 'timeline':    await loadTimeline(); break;
      case 'admin':       await loadAdmin(); break;
    }
  } catch(e){ console.error(e); }
  showLoader(false);
}

/* ── Overview ─────────────────────────────────────────────────────── */
const USER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function initDashboard(){
  showLoader(true);
  loaded.overview = true;
  try {
    const tz = encodeURIComponent(USER_TZ);
    const [profile, streak, recent, heatmap, genres] = await Promise.all([
      api('/api/profile'),
      api(`/api/listening_streak?tz=${tz}`),
      api('/api/recent_timeline'),
      api(`/api/weekly_heatmap?tz=${tz}`),
      api('/api/genre_breakdown'),
    ]);

    // Profile chip
    $('#profile-chip').classList.remove('hidden');
    $('#username').textContent = profile.display_name || profile.id;
    if(profile.images?.[0]) $('#avatar').src = profile.images[0].url;

    // Show admin tab if user is admin
    if(profile.is_admin){
      const adminTab = $('#admin-tab');
      if(adminTab) adminTab.classList.remove('hidden');
    }

    // Animated stats
    animCount($('#streak-val'), streak.streak);
    animCount($('#days-val'),   streak.active_days);
    animCount($('#plays-val'),  streak.total_plays);
    if(genres[0]){
      $('#top-genre-val').textContent = genres[0].genre;
      $('#top-genre-val').classList.add('small');
    }

    buildHourlyChart(heatmap);
    buildRecentList(recent.slice(0, 10));
  } catch(e){ console.error(e); }
  showLoader(false);
}

/* ── Hourly chart ─────────────────────────────────────────────────── */
function buildHourlyChart(heatmapData){
  const hours = Array(24).fill(0);
  heatmapData.forEach(({hour, count}) => hours[hour] += count);
  const peak = Math.max(...hours);
  new Chart($('#hourly-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: Array.from({length:24}, (_,h) => `${h}:00`),
      datasets: [{
        data: hours,
        backgroundColor: hours.map(v => v === peak ? 'rgba(29,185,84,.9)' : 'rgba(29,185,84,.35)'),
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend:{display:false}, tooltip:{callbacks:{title:t=>`${t[0].label}`}} },
      scales: {
        x: { ticks:{font:{size:9}, maxRotation:0, callback(v,i){ return i%6===0?this.getLabelForValue(i):''; }} },
        y: { ticks:{font:{size:9}}, beginAtZero:true }
      }
    }
  });
}

/* ── Recent list ──────────────────────────────────────────────────── */
function buildRecentList(items){
  $('#recent-list').innerHTML = items.map((t,i) => `
    <li>
      <span class="track-num">${i+1}</span>
      ${t.image?`<img class="track-img" src="${esc(t.image)}" alt="" loading="lazy"/>`:'<div class="track-img"></div>'}
      <div class="track-info">
        <div class="track-name">${esc(t.name)}</div>
        <div class="track-artist">${esc(t.artist)}</div>
      </div>
      <span class="track-time">${esc(t.time)}</span>
    </li>`).join('');
}

/* ── Personality ──────────────────────────────────────────────────── */
async function loadPersonality(){
  let p, decades;
  try {
    [p, decades] = await Promise.all([
      api('/api/personality'),
      api('/api/decade_breakdown'),
    ]);
  } catch(e) {
    if(e instanceof DeprecatedError) { deprecatedNotice('tab-personality'); return; }
    throw e;
  }

  $('#p-emoji').textContent = p.emoji || '🎵';
  $('#p-type').textContent  = p.type  || '—';
  $('#p-desc').textContent  = p.desc  || '';

  const scoresEl = $('#p-scores');
  scoresEl.innerHTML = Object.entries(p.scores||{}).map(([k,v]) => `
    <div class="p-score">
      <div class="p-score-val">${v}%</div>
      <div class="p-score-label">${esc(k)}</div>
    </div>`).join('');

  buildDecadeChart('decade-chart', decades);

  // Mood scatter for personality tab
  const scatter = await api('/api/mood_scatter?time_range=short_term');
  buildMoodChart('mood-chart', scatter);
}

/* ── Decade chart ─────────────────────────────────────────────────── */
function buildDecadeChart(canvasId, decades){
  const ctx = $(`#${canvasId}`).getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: decades.map(d => d.decade),
      datasets: [{
        label: 'Tracks',
        data: decades.map(d => d.count),
        backgroundColor: decades.map((_,i) => PALETTE[i % PALETTE.length] + '99'),
        borderColor:     decades.map((_,i) => PALETTE[i % PALETTE.length]),
        borderWidth: 1,
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend:{display:false} },
      scales: {
        x: { ticks:{font:{size:11}} },
        y: { ticks:{font:{size:10}}, beginAtZero:true }
      }
    }
  });
}

/* ── Mood scatter ─────────────────────────────────────────────────── */
function buildMoodChart(canvasId, scatter){
  const ctx = $(`#${canvasId}`);
  if(!ctx) return;
  const c = ctx.getContext('2d');

  new Chart(c, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Tracks',
        data: scatter.map(t => ({ x: t.valence, y: t.energy, label: t.name, artist: t.artist })),
        backgroundColor: 'rgba(29,185,84,.55)',
        borderColor:     'rgba(29,185,84,.9)',
        borderWidth: 1,
        pointRadius: 6,
        pointHoverRadius: 9,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display:false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const d = ctx.raw;
              return [`${d.label}`, `by ${d.artist}`, `Valence: ${Math.round(d.x*100)}% | Energy: ${Math.round(d.y*100)}%`];
            }
          }
        }
      },
      scales: {
        x: { min:0, max:1, title:{ display:true, text:'← Sad  ·  Valence  ·  Happy →', font:{size:11} }, ticks:{font:{size:9}} },
        y: { min:0, max:1, title:{ display:true, text:'Energy', font:{size:11} }, ticks:{font:{size:9}} }
      }
    }
  });
}

/* ── Heatmap ──────────────────────────────────────────────────────── */
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

async function loadHeatmap(){
  const data = await api(`/api/weekly_heatmap?tz=${encodeURIComponent(USER_TZ)}`);

  // Hour labels
  $('#heatmap-x-labels').innerHTML = Array.from({length:24},(_,h) =>
    `<span>${h%6===0?h:''}</span>`).join('');

  const grid = $('#heatmap-grid');
  grid.innerHTML = '';
  const map = {};
  let maxC = 1;
  data.forEach(({day,hour,count,tracks}) => {
    map[`${day}-${hour}`] = {count,tracks};
    if(count > maxC) maxC = count;
  });

  const tip = $('#hm-tooltip');

  for(let day=0; day<7; day++){
    for(let hour=0; hour<24; hour++){
      const entry = map[`${day}-${hour}`];
      const count = entry?.count || 0;
      const ratio = count/maxC;
      const size  = count>0 ? Math.max(8, Math.round(ratio*22)) : 4;
      const op    = count>0 ? 0.2 + ratio*0.8 : 0.07;

      const cell = document.createElement('div');
      cell.className = 'hm-cell';
      const dot = document.createElement('div');
      dot.className = 'hm-dot';
      dot.style.cssText = `width:${size}px;height:${size}px;opacity:${op.toFixed(2)};${count>0&&ratio>.6?`box-shadow:0 0 ${Math.round(ratio*12)}px rgba(29,185,84,.6);`:''}`;
      cell.appendChild(dot);

      if(count>0){
        cell.addEventListener('mousemove', e => {
          tip.innerHTML = `<strong>${DAYS[day]} ${String(hour).padStart(2,'0')}:00</strong><br>${count} play${count>1?'s':''}<br><em style="color:#6b6b8a">${(entry.tracks||[]).join(', ')}</em>`;
          tip.classList.add('show');
          tip.style.left = `${e.clientX+14}px`;
          tip.style.top  = `${e.clientY+14}px`;
        });
        cell.addEventListener('mouseleave', () => tip.classList.remove('show'));
      }
      grid.appendChild(cell);
    }
  }
}

/* ── Top Tracks ───────────────────────────────────────────────────── */
let decadeTracksChart = null;

async function loadTopTracks(range){
  const [tracks, decades] = await Promise.all([
    api(`/api/top_tracks?time_range=${range}`),
    api(`/api/decade_breakdown?time_range=${range}`),
  ]);

  $('#tracks-grid').innerHTML = tracks.map((t,i) => `
    <div class="track-card">
      ${t.image?`<img src="${esc(t.image)}" alt="" loading="lazy"/>`:'<div style="aspect-ratio:1;background:var(--border);border-radius:8px"></div>'}
      <div class="c-rank">#${i+1}</div>
      <div class="c-title">${esc(t.name)}</div>
      <div class="c-sub">${esc(t.artist)}</div>
      <div class="pop-bar"><div class="pop-fill" style="width:${t.popularity}%"></div></div>
    </div>`).join('');

  if(decadeTracksChart){ decadeTracksChart.destroy(); decadeTracksChart=null; }
  if(decades.length){
    const ctx = $('#decade-chart-tracks').getContext('2d');
    decadeTracksChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: decades.map(d=>d.decade),
        datasets: [{ label:'Tracks', data: decades.map(d=>d.count),
          backgroundColor: 'rgba(29,185,84,.4)', borderColor:'#1DB954',
          borderWidth:1, borderRadius:5, borderSkipped:false }]
      },
      options: { responsive:true, plugins:{legend:{display:false}},
        scales:{ x:{ticks:{font:{size:11}}}, y:{ticks:{font:{size:10}},beginAtZero:true} } }
    });
  }
}

$('#tab-toptracks').addEventListener('click', e => {
  const btn = e.target.closest('.time-btn'); if(!btn) return;
  $$('#tracks-time .time-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  showLoader(true); loadTopTracks(btn.dataset.range).finally(()=>showLoader(false));
});

/* ── Top Artists ──────────────────────────────────────────────────── */
async function loadTopArtists(range){
  const artists = await api(`/api/top_artists?time_range=${range}`);
  $('#artists-grid').innerHTML = artists.map((a,i) => `
    <div class="artist-card">
      ${a.image?`<img src="${esc(a.image)}" alt="" loading="lazy"/>`:'<div style="aspect-ratio:1;background:var(--border);border-radius:50%"></div>'}
      <div class="c-rank">#${i+1}</div>
      <div class="c-title">${esc(a.name)}</div>
      <div class="genre-tags">${a.genres.map(g=>`<span class="genre-tag">${esc(g)}</span>`).join('')}</div>
      <div class="c-followers">${fmtNum(a.followers)} followers</div>
      <div class="pop-bar"><div class="pop-fill" style="width:${a.popularity}%"></div></div>
    </div>`).join('');
}

$('#tab-topartists').addEventListener('click', e => {
  const btn = e.target.closest('.time-btn'); if(!btn) return;
  $$('#artists-time .time-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  showLoader(true); loadTopArtists(btn.dataset.range).finally(()=>showLoader(false));
});

/* ── Audio DNA ────────────────────────────────────────────────────── */
const FEAT_META = {
  danceability:     { label:'Danceability',     desc:'How suitable for dancing' },
  energy:           { label:'Energy',           desc:'Intensity and activity level' },
  valence:          { label:'Valence',          desc:'Musical positiveness' },
  acousticness:     { label:'Acousticness',     desc:'Confidence it\'s acoustic' },
  instrumentalness: { label:'Instrumentalness', desc:'Predicts no vocal content' },
  liveness:         { label:'Liveness',         desc:'Presence of live audience' },
  speechiness:      { label:'Speechiness',      desc:'Presence of spoken words' },
};

let radarChart = null, moodAudioChart = null;

async function loadAudio(){
  let feat, scatter;
  try {
    [feat, scatter] = await Promise.all([
      api('/api/audio_features'),
      api('/api/mood_scatter?time_range=short_term'),
    ]);
  } catch(e) {
    if(e instanceof DeprecatedError) { deprecatedNotice('tab-audio'); return; }
    throw e;
  }

  if(!feat || !Object.keys(feat).length) return;

  const keys   = Object.keys(FEAT_META);
  const values = keys.map(k => feat[k]||0);

  // Radar
  if(radarChart) radarChart.destroy();
  radarChart = new Chart($('#radar-chart').getContext('2d'), {
    type: 'radar',
    data: {
      labels: keys.map(k=>FEAT_META[k].label),
      datasets: [{
        label: 'Your Profile',
        data: values,
        backgroundColor: 'rgba(29,185,84,.15)',
        borderColor: '#1DB954',
        pointBackgroundColor: '#1DB954',
        pointBorderColor: '#080810',
        pointRadius: 5,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      scales: { r: {
        min:0, max:1,
        ticks:{display:false},
        grid:{color:'rgba(255,255,255,.08)'},
        angleLines:{color:'rgba(255,255,255,.08)'},
        pointLabels:{color:'#eeeef5', font:{size:12,weight:'600'}}
      }},
      plugins:{legend:{display:false}}
    }
  });

  // Feature bars
  $('#feature-bars').innerHTML = keys.map(k => {
    const pct = Math.round((feat[k]||0)*100);
    return `<div class="feat-row">
      <div class="feat-label-row">
        <span class="feat-name">${FEAT_META[k].label}</span>
        <span class="feat-val">${pct}%</span>
      </div>
      <div class="feat-bg"><div class="feat-fill" style="width:${pct}%"></div></div>
      <div class="feat-desc">${FEAT_META[k].desc}</div>
    </div>`;
  }).join('') + (feat.tempo ? `<div class="tempo-chip">Avg Tempo <strong style="color:var(--accent)">${feat.tempo} BPM</strong></div>` : '');

  // Mood scatter
  if(moodAudioChart) moodAudioChart.destroy();
  moodAudioChart = null;
  buildMoodChart('mood-chart-audio', scatter);
}

/* ── Genres ───────────────────────────────────────────────────────── */
let genreChart = null;

async function loadGenres(range){
  const genres = await api(`/api/genre_breakdown?time_range=${range}`);
  if(!genres.length) return;

  const top    = genres.slice(0,12);
  const maxC   = top[0].count;

  if(genreChart) genreChart.destroy();
  genreChart = new Chart($('#genre-chart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: top.map(g=>g.genre),
      datasets: [{
        data: top.map(g=>g.count),
        backgroundColor: PALETTE,
        borderColor: '#0e0e1a',
        borderWidth: 3,
        hoverOffset: 10,
      }]
    },
    options: {
      responsive: true,
      cutout: '58%',
      plugins: {
        legend: { position:'bottom', labels:{color:'#eeeef5', font:{size:11}, padding:14, boxWidth:12} }
      }
    }
  });

  $('#genre-list').innerHTML = genres.map((g,i) => `
    <div class="g-row">
      <span class="g-rank">${i+1}</span>
      <span class="g-name">${esc(g.genre)}</span>
      <div class="g-bar-bg"><div class="g-bar-fill" style="width:${Math.round(g.count/maxC*100)}%"></div></div>
      <span class="g-count">${g.count}</span>
    </div>`).join('');
}

$('#tab-genres').addEventListener('click', e => {
  const btn = e.target.closest('.time-btn'); if(!btn) return;
  $$('#genres-time .time-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  showLoader(true); loadGenres(btn.dataset.range).finally(()=>showLoader(false));
});

/* ── Timeline ─────────────────────────────────────────────────────── */
async function loadTimeline(){
  const items = await api('/api/recent_timeline');
  const tl = $('#timeline');
  let lastDate = null;
  tl.innerHTML = items.map(item => {
    const dt = new Date(item.played_at);
    const weekday = dt.toLocaleDateString(undefined, {weekday:'short'});
    const date = dt.toLocaleDateString(undefined, {month:'short', day:'numeric'});
    const time = dt.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', hour12:false});
    let dayHeader = '';
    const dateLabel = `${weekday}, ${date}`;
    if(dateLabel !== lastDate){
      lastDate = dateLabel;
      dayHeader = `<div class="tl-day">${esc(dateLabel)}</div>`;
    }
    return `${dayHeader}<div class="tl-item">
      <span class="tl-time">${esc(time)}</span>
      <div class="tl-dot"></div>
      ${item.image?`<img class="tl-img" src="${esc(item.image)}" alt="" loading="lazy"/>`:'<div class="tl-img"></div>'}
      <div class="tl-info">
        <div class="tl-name">${esc(item.name)}</div>
        <div class="tl-artist">${esc(item.artist)}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── Admin ────────────────────────────────────────────────────────── */
async function loadAdmin(){
  const users = await api('/api/admin/users');
  $('#admin-user-count').textContent = users.length;
  const container = $('#admin-users');
  container.innerHTML = users.map(u => {
    const date = u.created_at ? new Date(u.created_at).toLocaleDateString() : '';
    return `<div class="admin-user-row" data-uid="${esc(u.spotify_id)}">
      <div class="admin-user-info">
        <strong>${esc(u.display_name || u.spotify_id)}</strong>
        <span class="admin-user-meta">${esc(u.spotify_id)} · ${u.play_count} plays · joined ${date}</span>
      </div>
      <button class="btn-sm" data-uid="${esc(u.spotify_id)}" data-name="${esc(u.display_name || u.spotify_id)}">View Heatmap</button>
    </div>`;
  }).join('');

  container.querySelectorAll('.btn-sm').forEach(btn => {
    btn.addEventListener('click', () => loadAdminHeatmap(btn.dataset.uid, btn.dataset.name));
  });
}

async function loadAdminHeatmap(uid, name){
  showLoader(true);
  try {
    const data = await api(`/api/admin/heatmap/${uid}?tz=${encodeURIComponent(USER_TZ)}`);
    const card = $('#admin-heatmap-card');
    card.classList.remove('hidden');
    $('#admin-heatmap-title').textContent = `${name}'s Heatmap`;

    // X labels
    $('#admin-heatmap-x').innerHTML = Array.from({length:24},(_,h) =>
      `<span>${h%6===0?h:''}</span>`).join('');

    // Y labels
    $('#admin-heatmap-y').innerHTML = DAYS.map(d => `<span>${d}</span>`).join('');

    const grid = $('#admin-heatmap-grid');
    grid.innerHTML = '';
    const map = {};
    let maxC = 1;
    data.forEach(({day,hour,count,tracks}) => {
      map[`${day}-${hour}`] = {count,tracks};
      if(count > maxC) maxC = count;
    });

    const tip = $('#hm-tooltip');
    for(let day=0; day<7; day++){
      for(let hour=0; hour<24; hour++){
        const entry = map[`${day}-${hour}`];
        const count = entry?.count || 0;
        const ratio = count/maxC;
        const size  = count>0 ? Math.max(8, Math.round(ratio*22)) : 4;
        const op    = count>0 ? 0.2 + ratio*0.8 : 0.07;

        const cell = document.createElement('div');
        cell.className = 'hm-cell';
        const dot = document.createElement('div');
        dot.className = 'hm-dot';
        dot.style.cssText = `width:${size}px;height:${size}px;opacity:${op.toFixed(2)};${count>0&&ratio>.6?`box-shadow:0 0 ${Math.round(ratio*12)}px rgba(29,185,84,.6);`:''}`;
        cell.appendChild(dot);

        if(count>0){
          cell.addEventListener('mousemove', e => {
            tip.innerHTML = `<strong>${DAYS[day]} ${String(hour).padStart(2,'0')}:00</strong><br>${count} play${count>1?'s':''}<br><em style="color:#6b6b8a">${(entry.tracks||[]).join(', ')}</em>`;
            tip.classList.add('show');
            tip.style.left = `${e.clientX+14}px`;
            tip.style.top  = `${e.clientY+14}px`;
          });
          cell.addEventListener('mouseleave', () => tip.classList.remove('show'));
        }
        grid.appendChild(cell);
      }
    }
  } catch(e){ console.error(e); }
  showLoader(false);
}

/* ── Sync button ──────────────────────────────────────────────────── */
(function(){
  const syncBtn    = $('#sync-btn');
  const syncStatus = $('#sync-status');
  if(!syncBtn) return;

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncStatus.textContent = 'Syncing…';
    syncStatus.style.color = '#6b6b8a';
    try {
      const result = await api('/api/sync');
      syncStatus.textContent = `+${result.new_tracks} new · ${result.total_stored} total`;
      syncStatus.style.color = '#1DB954';
    } catch(e) {
      syncStatus.textContent = e.serverMsg ? `Error: ${e.serverMsg}` : 'Sync failed';
      syncStatus.style.color = '#e05c5c';
    } finally {
      syncBtn.disabled = false;
    }
  });
})();

/* ── Init ─────────────────────────────────────────────────────────── */
initDashboard();
