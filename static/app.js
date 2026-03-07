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
      case 'toptracks':   await loadTopTracks('short_term'); loadMostPlayed(); break;
      case 'topartists':  await loadTopArtists('short_term'); break;
      case 'audio':       await loadAudio(); break;
      case 'genres':      await loadGenres('short_term'); break;
      case 'timeline':    await loadTimeline(); break;
      case 'weekly':      await loadWeekly(); break;
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

    // Load milestones (non-blocking)
    api(`/api/milestones?tz=${tz}`).then(buildMilestones).catch(()=>{});

    // Load listening personality (non-blocking)
    api(`/api/listening_personality?tz=${tz}`).then(buildListeningPersonality).catch(()=>{});
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

  // Load artist flow once (non-blocking)
  if(!afLoaded){
    afLoaded = true;
    api('/api/artist_flow').then(buildArtistFlow).catch(()=>{});
  }
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

/* ── Most Played ─────────────────────────────────────────────────── */
async function loadMostPlayed(){
  try {
    const tracks = await api('/api/most_played?limit=20');
    const el = $('#most-played-list');
    if(!el || !tracks.length){ if(el) el.innerHTML = '<p style="color:var(--dim);padding:12px">No play history yet. Hit Sync to start tracking!</p>'; return; }
    el.innerHTML = tracks.map((t,i) => `
      <div class="mp-row">
        <span class="mp-rank">${i+1}</span>
        <div class="mp-info">
          <div class="mp-name">${esc(t.name)}</div>
          <div class="mp-artist">${esc(t.artist)}</div>
        </div>
        <div class="mp-count">${t.play_count}<span class="mp-count-label"> plays</span></div>
      </div>`).join('');
  } catch(e){ console.error('Most played:', e); }
}

/* ── Milestones ──────────────────────────────────────────────────── */
function buildMilestones(milestones){
  const el = $('#milestones-grid');
  if(!el || !milestones.length) return;

  // Sort: unlocked first, then by target ascending
  milestones.sort((a,b) => {
    if(a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    return a.target - b.target;
  });

  el.innerHTML = milestones.map(m => {
    const pct = Math.min(Math.round(m.current / m.target * 100), 100);
    return `<div class="milestone ${m.unlocked ? 'unlocked' : 'locked'}">
      <div class="ms-emoji">${m.emoji}</div>
      <div class="ms-title">${esc(m.title)}</div>
      <div class="ms-desc">${esc(m.desc)}</div>
      <div class="ms-progress-bg"><div class="ms-progress-fill" style="width:${pct}%"></div></div>
      <div class="ms-pct">${m.unlocked ? '✓ Unlocked' : `${m.current} / ${m.target}`}</div>
    </div>`;
  }).join('');
}

/* ── Listening Personality ────────────────────────────────────────── */
let lpChart = null;

function buildListeningPersonality(data){
  const section = $('#listening-personality-section');
  if(!section) return;
  if(!data || data.type === 'Unknown'){
    section.style.display = 'none';
    return;
  }

  $('#lp-emoji').textContent = data.emoji || '🎵';
  $('#lp-type').textContent = data.type || '—';
  $('#lp-desc').textContent = data.desc || '';
  if(data.fun_stat) $('#lp-fun').textContent = data.fun_stat;

  // Doughnut chart of 4 time blocks
  if(data.blocks && Object.keys(data.blocks).length){
    const labels = Object.keys(data.blocks);
    const values = Object.values(data.blocks);
    const colors = ['#f59e0b','#ef4444','#8b5cf6','#3b82f6'];

    if(lpChart){ lpChart.destroy(); lpChart=null; }
    lpChart = new Chart($('#lp-chart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: '#0e0e1a',
          borderWidth: 3,
          hoverOffset: 8,
        }]
      },
      options: {
        responsive: true,
        cutout: '55%',
        plugins: {
          legend: { position:'bottom', labels:{color:'#eeeef5', font:{size:11}, padding:12, boxWidth:12} }
        }
      }
    });
  }
}

/* ── Artist Flow ─────────────────────────────────────────────────── */
let afChart = null;
let afLoaded = false;

function buildArtistFlow(data){
  const section = $('#artist-flow-section');
  if(!section) return;
  if(!data || !data.transitions || !data.transitions.length){
    section.style.display = 'none';
    return;
  }

  // Horizontal bar chart: top 10 transitions
  const top10 = data.transitions.slice(0, 10);
  const labels = top10.map(t => `${t.from} → ${t.to}`);
  const values = top10.map(t => t.count);

  if(afChart){ afChart.destroy(); afChart=null; }
  afChart = new Chart($('#af-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Transitions',
        data: values,
        backgroundColor: 'rgba(139,92,246,.5)',
        borderColor: '#8b5cf6',
        borderWidth: 1,
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend:{display:false} },
      scales: {
        x: { beginAtZero:true, ticks:{font:{size:10}} },
        y: { ticks:{font:{size:11}, color:'#eeeef5'} }
      }
    }
  });

  // Transition list (all 15)
  const listEl = $('#af-list');
  if(listEl){
    listEl.innerHTML = data.transitions.map((t,i) => `
      <div class="af-row">
        <span class="af-rank">${i+1}</span>
        <span class="af-from">${esc(t.from)}</span>
        <span class="af-arrow">→</span>
        <span class="af-to">${esc(t.to)}</span>
        <span class="af-count">${t.count}×</span>
      </div>`).join('');
  }
}

/* ── Discovery Rate ──────────────────────────────────────────────── */
let drChart = null;

function buildDiscoveryRate(data){
  const section = $('#discovery-section');
  if(!section) return;
  if(!data || !data.weeks || !data.weeks.length){
    section.style.display = 'none';
    return;
  }

  // Stat cards
  const stats = data.stats || {};
  $('#dr-stats').innerHTML = `
    <div class="stat-grid" style="margin-bottom:0">
      <div class="stat-card"><div class="stat-icon">🎵</div><div class="stat-value">${stats.total_unique_tracks || 0}</div><div class="stat-label">Unique Tracks</div></div>
      <div class="stat-card"><div class="stat-icon">🎤</div><div class="stat-value">${stats.total_unique_artists || 0}</div><div class="stat-label">Unique Artists</div></div>
      <div class="stat-card"><div class="stat-icon">🔍</div><div class="stat-value">${stats.discovery_ratio || 0}%</div><div class="stat-label">Discovery Ratio</div></div>
      <div class="stat-card"><div class="stat-icon">▶️</div><div class="stat-value">${stats.total_plays || 0}</div><div class="stat-label">Total Plays</div></div>
    </div>`;

  // Line chart: new tracks vs replays per week
  const weeks = data.weeks;
  const labels = weeks.map(w => {
    const d = new Date(w.week + 'T00:00:00');
    return d.toLocaleDateString(undefined, {month:'short', day:'numeric'});
  });

  if(drChart){ drChart.destroy(); drChart=null; }
  drChart = new Chart($('#dr-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'New Tracks',
          data: weeks.map(w => w.new_tracks),
          borderColor: '#1DB954',
          backgroundColor: 'rgba(29,185,84,.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 6,
          borderWidth: 2,
        },
        {
          label: 'Replays',
          data: weeks.map(w => w.replays),
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 6,
          borderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels:{color:'#eeeef5', font:{size:11}} }
      },
      scales: {
        x: { ticks:{font:{size:10}, maxRotation:45} },
        y: { beginAtZero:true, ticks:{font:{size:10}} }
      }
    }
  });
}

/* ── Album Art Collage ───────────────────────────────────────────── */
function buildAlbumCollage(albums){
  const section = $('#collage-section');
  if(!section) return;
  if(!albums || !albums.length){
    section.style.display = 'none';
    return;
  }

  const grid = $('#collage-grid');
  grid.innerHTML = albums.map(a => `
    <div class="collage-item">
      <img src="${esc(a.image)}" alt="${esc(a.name)}" crossorigin="anonymous" loading="lazy"/>
      <div class="collage-overlay">
        <div class="collage-name">${esc(a.name)}</div>
        <div class="collage-artist">${esc(a.artist)}</div>
      </div>
    </div>`).join('');

  // Download handler
  const btn = $('#download-collage-btn');
  if(btn){
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', async () => {
      if(typeof html2canvas === 'undefined') return;
      newBtn.disabled = true;
      newBtn.textContent = 'Generating…';
      try {
        const canvas = await html2canvas(grid, {
          backgroundColor: '#0e0e1a',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        const link = document.createElement('a');
        link.download = 'album-collage.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch(e){ console.error('Collage export:', e); }
      newBtn.disabled = false;
      newBtn.textContent = 'Download Collage';
    });
  }
}

/* ── Weekly Report ───────────────────────────────────────────────── */
let weeklyDailyChart = null, weeklyHourlyChart = null;

async function loadWeekly(){
  const tz = encodeURIComponent(USER_TZ);

  let data;
  try {
    data = await api(`/api/weekly_summary?tz=${tz}`);
  } catch(e){
    const el = $('#weekly-report');
    if(el) el.innerHTML = '<p style="color:var(--dim);padding:24px;text-align:center">Weekly report requires a database. No data available yet.</p>';
    return;
  }

  const tw = data.this_week;
  const lw = data.last_week;
  const ch = data.changes;

  // Period badge
  const periodEl = $('#weekly-period');
  if(periodEl){
    const start = new Date(data.period.this_start);
    periodEl.textContent = `Week of ${start.toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;
  }

  // Stats with comparison
  function changeTag(val){
    if(val > 0) return `<span class="change-up">▲ ${val}%</span>`;
    if(val < 0) return `<span class="change-down">▼ ${Math.abs(val)}%</span>`;
    return `<span class="change-flat">— 0%</span>`;
  }

  $('#weekly-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon">▶️</div><div class="stat-value">${tw.total_plays}</div><div class="stat-label">Plays ${changeTag(ch.plays)}</div></div>
    <div class="stat-card"><div class="stat-icon">🎵</div><div class="stat-value">${tw.unique_tracks}</div><div class="stat-label">Unique Tracks ${changeTag(ch.tracks)}</div></div>
    <div class="stat-card"><div class="stat-icon">🎤</div><div class="stat-value">${tw.unique_artists}</div><div class="stat-label">Artists ${changeTag(ch.artists)}</div></div>
    <div class="stat-card"><div class="stat-icon">📊</div><div class="stat-value">${lw.total_plays}</div><div class="stat-label">Last Week Plays</div></div>
  `;

  // Daily chart
  if(weeklyDailyChart){ weeklyDailyChart.destroy(); weeklyDailyChart=null; }
  const dailyLabels = tw.daily.map(d => {
    const dt = new Date(d.date + 'T00:00:00');
    return dt.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
  });
  weeklyDailyChart = new Chart($('#weekly-daily-chart').getContext('2d'),{
    type:'bar',
    data:{
      labels: dailyLabels,
      datasets:[{
        label:'Plays', data: tw.daily.map(d=>d.count),
        backgroundColor:'rgba(29,185,84,.5)', borderColor:'#1DB954',
        borderWidth:1, borderRadius:6, borderSkipped:false
      }]
    },
    options:{responsive:true, plugins:{legend:{display:false}},
      scales:{x:{ticks:{font:{size:10}}}, y:{beginAtZero:true, ticks:{font:{size:10}}}}}
  });

  // Hourly chart
  if(weeklyHourlyChart){ weeklyHourlyChart.destroy(); weeklyHourlyChart=null; }
  weeklyHourlyChart = new Chart($('#weekly-hourly-chart').getContext('2d'),{
    type:'bar',
    data:{
      labels: Array.from({length:24},(_,h)=>`${h}:00`),
      datasets:[
        {label:'This Week', data:tw.hourly, backgroundColor:'rgba(29,185,84,.5)', borderColor:'#1DB954', borderWidth:1, borderRadius:4, borderSkipped:false},
        {label:'Last Week', data:lw.hourly, backgroundColor:'rgba(139,92,246,.3)', borderColor:'#8b5cf6', borderWidth:1, borderRadius:4, borderSkipped:false},
      ]
    },
    options:{responsive:true,
      plugins:{legend:{labels:{color:'#eeeef5',font:{size:11}}}},
      scales:{x:{ticks:{font:{size:8},maxRotation:0,callback(v,i){return i%6===0?this.getLabelForValue(i):''}}}, y:{beginAtZero:true,ticks:{font:{size:10}}}}}
  });

  // Top tracks
  $('#weekly-tracks').innerHTML = tw.top_tracks.length ? tw.top_tracks.map((t,i) => `
    <div class="admin-item">
      <span class="admin-rank">${i+1}</span>
      <div><strong>${esc(t.name)}</strong><br><span class="admin-user-meta">${esc(t.artist)} · ${t.count} plays</span></div>
    </div>`).join('') : '<p style="color:var(--dim);padding:12px">No plays this week yet</p>';

  // Top artists
  $('#weekly-artists').innerHTML = tw.top_artists.length ? tw.top_artists.map((a,i) => `
    <div class="admin-item">
      <span class="admin-rank">${i+1}</span>
      <div><strong>${esc(a.name)}</strong><br><span class="admin-user-meta">${a.count} plays</span></div>
    </div>`).join('') : '<p style="color:var(--dim);padding:12px">No plays this week yet</p>';

  // Load profile card
  loadProfileCard();

  // Load discovery rate (non-blocking)
  api(`/api/discovery_rate?tz=${tz}`).then(buildDiscoveryRate).catch(()=>{});

  // Load album collage (non-blocking)
  api('/api/top_albums').then(buildAlbumCollage).catch(()=>{});
}

/* ── Profile Card ────────────────────────────────────────────────── */
async function loadProfileCard(){
  const tz = encodeURIComponent(USER_TZ);
  try {
    const card = await api(`/api/profile_card?tz=${tz}`);
    if(card.image) $('#pc-avatar').src = card.image;
    $('#pc-name').textContent = card.display_name || 'Music Lover';

    $('#pc-stats').innerHTML = `
      <div class="pc-stat"><div class="pc-stat-val">${card.total_plays}</div><div class="pc-stat-label">Plays</div></div>
      <div class="pc-stat"><div class="pc-stat-val">${card.active_days}</div><div class="pc-stat-label">Active Days</div></div>
      <div class="pc-stat"><div class="pc-stat-val">${card.streak}</div><div class="pc-stat-label">Day Streak</div></div>
    `;

    $('#pc-tracks').innerHTML = card.top_tracks.map((t,i) =>
      `<div class="pc-item">${i+1}. ${esc(t.name)} <span style="color:var(--dim)">— ${esc(t.artist)}</span></div>`
    ).join('') || '<div class="pc-item" style="color:var(--dim)">No data</div>';

    $('#pc-artists').innerHTML = card.top_artists.map((a,i) =>
      `<div class="pc-item">${i+1}. ${esc(a)}</div>`
    ).join('') || '<div class="pc-item" style="color:var(--dim)">No data</div>';

    if(card.top_genre) $('#pc-genre').textContent = `🎸 ${card.top_genre}`;
  } catch(e){ console.error('Profile card:', e); }
}

// Download profile card as image
(function(){
  const btn = $('#download-card-btn');
  if(!btn) return;
  btn.addEventListener('click', async () => {
    const card = $('#profile-card');
    if(!card || typeof html2canvas === 'undefined') return;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const canvas = await html2canvas(card, {
        backgroundColor: '#0e0e1a',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const link = document.createElement('a');
      link.download = 'music-analyzer-card.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch(e){ console.error('Card export:', e); }
    btn.disabled = false;
    btn.textContent = 'Download Card';
  });
})();

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
      <button class="btn-sm" data-uid="${esc(u.spotify_id)}" data-name="${esc(u.display_name || u.spotify_id)}">View Stats</button>
    </div>`;
  }).join('');

  container.querySelectorAll('.btn-sm').forEach(btn => {
    btn.addEventListener('click', () => loadAdminUserDetail(btn.dataset.uid, btn.dataset.name));
  });

  $('#admin-back-btn').addEventListener('click', () => {
    $('#admin-detail').classList.add('hidden');
    container.parentElement.classList.remove('hidden');
  });
}

async function loadAdminUserDetail(uid, name){
  showLoader(true);
  $('#admin-users').parentElement.classList.add('hidden');
  const detail = $('#admin-detail');
  detail.classList.remove('hidden');
  $('#admin-detail-title').textContent = name;

  try {
    const tz = encodeURIComponent(USER_TZ);
    const [stats, heatmap] = await Promise.all([
      api(`/api/admin/stats/${uid}?tz=${tz}`),
      api(`/api/admin/heatmap/${uid}?tz=${tz}`),
    ]);

    // Streak stats
    const s = stats.streak || {};
    $('#admin-stats').innerHTML = `
      <div class="stat-card"><div class="stat-icon">🔥</div><div class="stat-value">${s.streak||0}</div><div class="stat-label">Day Streak</div></div>
      <div class="stat-card"><div class="stat-icon">📅</div><div class="stat-value">${s.active_days||0}</div><div class="stat-label">Active Days</div></div>
      <div class="stat-card"><div class="stat-icon">🎵</div><div class="stat-value">${s.total_plays||0}</div><div class="stat-label">Total Plays</div></div>
    `;

    // Top tracks
    const tracks = stats.top_tracks || [];
    $('#admin-tracks').innerHTML = tracks.length ? tracks.map((t,i) => `
      <div class="admin-item">
        <span class="admin-rank">${i+1}</span>
        ${t.image?`<img class="admin-item-img" src="${esc(t.image)}" alt=""/>`:''}
        <div><strong>${esc(t.name)}</strong><br><span class="admin-user-meta">${esc(t.artist)}</span></div>
      </div>
    `).join('') : '<p style="color:var(--dim);padding:12px">No data (user may not be a Spotify tester)</p>';

    // Top artists
    const artists = stats.top_artists || [];
    $('#admin-artists').innerHTML = artists.length ? artists.map((a,i) => `
      <div class="admin-item">
        <span class="admin-rank">${i+1}</span>
        ${a.image?`<img class="admin-item-img" src="${esc(a.image)}" alt="" style="border-radius:50%"/>`:''}
        <div><strong>${esc(a.name)}</strong><br><span class="admin-user-meta">${(a.genres||[]).join(', ')}</span></div>
      </div>
    `).join('') : '<p style="color:var(--dim);padding:12px">No data</p>';

    // Genres
    const genres = stats.genres || [];
    $('#admin-genres').innerHTML = genres.length ? genres.map(g =>
      `<span class="genre-pill">${esc(g.genre)} <strong>${g.count}</strong></span>`
    ).join(' ') : '<p style="color:var(--dim);padding:12px">No data</p>';

    // Heatmap
    renderAdminHeatmap(heatmap);

  } catch(e){ console.error(e); }
  showLoader(false);
}

function renderAdminHeatmap(data){
  $('#admin-heatmap-x').innerHTML = Array.from({length:24},(_,h) =>
    `<span>${h%6===0?h:''}</span>`).join('');
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
