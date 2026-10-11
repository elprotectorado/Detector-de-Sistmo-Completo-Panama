/* ======================================================================
   Parte 4 · secciones: Eventos, Réplicas, Datos, Guía, Ajustes
   ====================================================================== */
let curTab = 'radar';
const TABS = ['radar', 'eventos', 'replicas', 'datos', 'guia', 'ajustes'];
const TAB_NAME = { radar: 'Radar', eventos: 'Eventos', replicas: 'Réplicas', datos: 'Datos', guia: 'Guía', ajustes: 'Ajustes' };
const head = (h, p, extra) => '<div class="pagehead"><div><h2>' + h + '</h2><p>' + p + '</p></div>' + (extra || '') + '</div>';
const roleTag = (q) => q.role === 'main' ? '<span class="tag main">principal · ' + (q.nrep || 0) + ' réplicas</span>' : q.role === 'after' ? '<span class="tag rep">réplica</span>' : q.role === 'fore' ? '<span class="tag pre">premonitor?</span>' : '';

function setupCanvas(cv, h) {
  const w = Math.max(200, cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 300), dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.style.height = h + 'px'; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); if (!c) return null; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h); return { c, w, h };
}
function bEst(mags) {
  if (mags.length < 30) return null;
  const bins = {}; mags.forEach((m) => { const k = Math.round(m * 10) / 10; bins[k] = (bins[k] || 0) + 1; });
  let mc = 0, best = -1; Object.keys(bins).forEach((k) => { if (bins[k] > best) { best = bins[k]; mc = +k; } });
  const sel = mags.filter((m) => m >= mc); if (sel.length < 20) return null;
  const mean = sel.reduce((a, b) => a + b, 0) / sel.length;
  return { b: Math.log10(Math.E) / (mean - (mc - 0.05)), mc, n: sel.length };
}
function barChart(cv, vals, labels, colors, h) {
  const s = setupCanvas(cv, h || 150); if (!s) return; const { c, w } = s, H = s.h, n = vals.length, mx = Math.max(1, ...vals), pad = 22, bw = (w - 10) / n;
  c.font = '11px ui-monospace,monospace'; c.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const bh = (H - pad - 16) * vals[i] / mx, x = 5 + i * bw + bw * 0.16, y = H - pad - bh;
    c.fillStyle = typeof colors === 'function' ? colors(i) : (colors || '#27f0c4'); c.globalAlpha = 0.85; c.fillRect(x, y, bw * 0.68, Math.max(vals[i] ? 2 : 0, bh)); c.globalAlpha = 1;
    c.fillStyle = '#e8f4ff'; if (vals[i]) c.fillText(String(vals[i]), x + bw * 0.34, y - 4);
    c.fillStyle = '#7f9bb0'; c.fillText(labels[i], x + bw * 0.34, H - 7);
  }
}
function lineChart(cv, pts, h, col) {
  const s = setupCanvas(cv, h || 140); if (!s) return; const { c, w } = s, H = s.h; if (pts.length < 2) { c.fillStyle = '#7f9bb0'; c.fillText('Sin datos suficientes', 10, 20); return; }
  const mx = Math.max(1, ...pts.map((p) => p[1])), t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  c.strokeStyle = 'rgba(120,170,200,.15)'; c.lineWidth = 1; for (let i = 1; i < 4; i++) { const y = 8 + (H - 30) * i / 4; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  c.beginPath(); pts.forEach((p, i) => { const x = 6 + (w - 12) * (p[0] - t0) / (t1 - t0 || 1), y = H - 20 - (H - 34) * p[1] / mx; i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = col || '#27f0c4'; c.lineWidth = 2; c.stroke();
  c.lineTo(w - 6, H - 20); c.lineTo(6, H - 20); c.closePath(); c.fillStyle = 'rgba(39,240,196,.10)'; c.fill();
  c.fillStyle = '#7f9bb0'; c.font = '11px ui-monospace,monospace'; c.fillText('0', 6, H - 6); c.textAlign = 'right'; c.fillText(String(mx), w - 6, 12);
}

/* ---------- Estado de fuentes (LEDs de la cabecera) ---------- */
function renderLeds() {
  const el = $('#leds'); if (!el) return;
  const age = Date.now() - apiAt, mk = (name, cls, tip) => '<span class="led ' + cls + '" title="' + esc(tip) + '"><i></i>' + name + '</span>';
  let h = '';
  const apiCls = !navigator.onLine ? 'bad' : apiOk ? (age < 90e3 ? 'ok' : 'warn') : 'bad';
  h += mk('API', apiCls, apiOk ? 'Servidor al día hace ' + Math.round(age / 1000) + ' s' : 'Sin respuesta del servidor' + (lastErr ? ': ' + lastErr : ''));
  ['IGC', 'USGS', 'EMSC'].forEach((n) => {
    const s = SRC[n]; let cls = s ? (s.ok ? (s.stale ? 'warn' : 'ok') : 'bad') : ''; if (!apiOk && s) cls = 'warn';
    h += mk(n === 'IGC' ? 'IGC' : n, cls, s ? (s.ok ? s.n + ' eventos' + (s.stale ? ' (datos guardados)' : '') + ' · ' + s.ms + ' ms' : 'Fallo: ' + (s.err || 'sin datos')) : 'Sin información');
  });
  h += mk('EN VIVO', wsOn ? 'ok' : 'warn', wsOn ? 'WebSocket EMSC conectado (segundos)' : 'WebSocket EMSC desconectado: se usa sondeo cada ~12 s');
  el.innerHTML = h;
}

function renderAll() {
  try { renderLeds(); renderHero(); drawRibbon(); drawMap(); badge(); } catch (e) { console.error(e); }
  const f = { eventos: renderEventos, replicas: renderReplicas, datos: renderDatos };
  if (f[curTab]) try { f[curTab](); } catch (e) { console.error(e); }
}

/* ======================= EVENTOS ======================= */
let EVF = Object.assign({ range: '7d', min: 0, reg: 'pan', st: '', src: '', q: '', role: '' }, LS.get('evf', {}));
let evBuilt = false;
function filteredEv() {
  const now = Date.now(), ms = { '1h': 3600e3, '24h': 864e5, '7d': 8 * 864e5 }[EVF.range] || 864e5, qq = EVF.q.trim().toLowerCase();
  return Q.filter((q) => {
    if (q.local) return false;
    if (now - q.t > ms || q.mag < EVF.min) return false;
    if (EVF.reg === 'pan' && !inBox(q, PAN)) return false;
    if (EVF.st && (q.st === 'R') !== (EVF.st === 'R')) return false;
    if (EVF.src && !(q.src || []).includes(EVF.src)) return false;
    if (EVF.role === 'rep' && q.role !== 'after') return false;
    if (EVF.role === 'main' && q.role !== 'main') return false;
    if (qq && !(q.place || '').toLowerCase().includes(qq) && String(q.mag.toFixed(1)).indexOf(qq) < 0) return false;
    return true;
  });
}
function renderEventos() {
  const root = $('#v-eventos');
  if (!evBuilt) {
    evBuilt = true;
    const sel = (id, opts, cur) => '<select id="' + id + '">' + opts.map((o) => '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
    root.innerHTML = '<div class="wrap">' + head('EVENTOS', 'Catálogo unificado IGC-UP + USGS + EMSC · hora de Panamá', '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="evCsv">CSV</button><button class="btn sm" id="evGj">GeoJSON</button></div>') +
      '<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<div class="seg" id="evRange"><button data-v="1h">1 h</button><button data-v="24h">24 h</button><button data-v="7d">7 d</button></div>' +
      sel('evMin', [[0, 'Toda magnitud'], [2.5, '≥ M2.5'], [3.5, '≥ M3.5'], [4.5, '≥ M4.5'], [5.5, '≥ M5.5']], EVF.min) +
      sel('evReg', [['pan', 'Panamá y mar adyacente'], ['all', 'Región ampliada']], EVF.reg) +
      sel('evSt', [['', 'Revisado y preliminar'], ['R', 'Solo revisados'], ['P', 'Solo preliminares']], EVF.st) +
      sel('evSrc', [['', 'Todas las fuentes'], ['IGC', 'IGC-UP'], ['USGS', 'USGS'], ['EMSC', 'EMSC']], EVF.src) +
      sel('evRole', [['', 'Todos los tipos'], ['main', 'Solo principales'], ['rep', 'Solo réplicas']], EVF.role) +
      '<input type="text" id="evQ" placeholder="Buscar lugar o magnitud" value="' + esc(EVF.q) + '" style="flex:1;min-width:140px"></div>' +
      '<div class="note" id="evCount" style="margin-top:8px"></div></div><div class="card" id="evList" style="margin-top:12px"></div></div>';
    const upd = () => { LS.set('evf', EVF); renderEventos(); };
    $$('#evRange button').forEach((b) => b.addEventListener('click', () => { EVF.range = b.dataset.v; upd(); }));
    [['evMin', 'min', Number], ['evReg', 'reg', String], ['evSt', 'st', String], ['evSrc', 'src', String], ['evRole', 'role', String]].forEach((a) => $('#' + a[0]).addEventListener('change', (e) => { EVF[a[1]] = a[2](e.target.value); upd(); }));
    $('#evQ').addEventListener('input', debounce((e) => { EVF.q = e.target.value; upd(); }, 200));
    $('#evCsv').addEventListener('click', () => exportData('csv')); $('#evGj').addEventListener('click', () => exportData('geojson'));
    $('#evList').addEventListener('click', (e) => { const r = e.target.closest('.ev'); if (r) selectEvent(r.dataset.id, true); });
  }
  $$('#evRange button').forEach((b) => b.classList.toggle('on', b.dataset.v === EVF.range));
  const list = filteredEv(), now = Date.now();
  $('#evCount').textContent = list.length + ' evento(s)' + (list.length ? ' · mayor M' + Math.max(...list.map((q) => q.mag)).toFixed(1) : '') + ' · actualizado ' + (apiAt ? ago(apiAt) : 'nunca');
  $('#evList').innerHTML = list.length ? list.slice(0, 250).map((q) => {
    const lv = levelFor(q, user), d = km(user, q);
    return '<div class="ev' + (q.id === SEL ? ' sel' : '') + '" data-id="' + esc(q.id) + '"><div class="mg" style="--c:' + magColor(q.mag) + '">' + q.mag.toFixed(1) + '</div><div class="b"><b>' + esc(placeShort(q.place)) + '</b><small>' +
      '<span>' + when(q.t) + '</span><span>' + ago(q.t) + '</span><span>prof. ' + Math.round(q.depth || 0) + ' km</span><span>a ' + Math.round(d) + ' km</span>' +
      (q.st === 'R' ? '<span class="tag rev">rev</span>' : '<span class="tag pre">prelim</span>') + (lv >= 2 ? '<span class="tag" style="color:' + LV_COLOR[lv] + ';border-color:' + LV_COLOR[lv] + '">' + LV_NAME[lv] + '</span>' : '') + roleTag(q) + srcTags(q) + '</small></div></div>';
  }).join('') : '<div class="empty">Sin eventos con estos filtros.<br><small>Prueba ampliar el rango o bajar la magnitud mínima.</small></div>';
}
function exportData(kind) {
  const list = filteredEv().length ? filteredEv() : Q;
  let body, type, name = 'sismos-panama-' + new Date().toISOString().slice(0, 10);
  if (kind === 'csv') {
    body = 'id,hora_utc,hora_panama,magnitud,profundidad_km,latitud,longitud,lugar,estado,fuentes,rol\n' + list.map((q) => [q.id, new Date(q.t).toISOString(), '"' + when(q.t) + '"', q.mag.toFixed(1), Math.round(q.depth || 0), q.lat.toFixed(4), q.lon.toFixed(4), '"' + String(q.place).replace(/"/g, '""') + '"', q.st === 'R' ? 'revisado' : 'preliminar', (q.src || []).join('+'), q.role].join(',')).join('\n');
    type = 'text/csv'; name += '.csv';
  } else {
    body = JSON.stringify({ type: 'FeatureCollection', features: list.map((q) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat, -(q.depth || 0)] }, properties: { id: q.id, time: q.t, iso: new Date(q.t).toISOString(), mag: q.mag, place: q.place, status: q.st, sources: q.src, role: q.role } })) });
    type = 'application/geo+json'; name += '.geojson';
  }
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800); toast('Exportado', name, 'good'); } catch (e) { toast('No se pudo exportar', String(e), 'bad'); }
}

/* ======================= RÉPLICAS ======================= */
function renderReplicas() {
  const root = $('#v-replicas'), now = Date.now();
  const seqs = Q.filter((q) => (q.role === 'main' || (q.mag >= 4.5 && q.role !== 'after')) && now - q.t < 8 * 864e5 && inBox(q, REG)).sort((a, b) => b.t - a.t);
  const reps24 = Q.filter((q) => q.role === 'after' && now - q.t < 864e5).length, fores = Q.filter((q) => q.role === 'fore' && now - q.t < 8 * 864e5).length;
  let h = '<div class="wrap">' + head('RÉPLICAS Y SECUENCIAS', 'Un sismo grande suele ir seguido de réplicas durante días. Aquí se agrupan automáticamente (método Gardner–Knopoff).') +
    '<div class="grid g4"><div class="card kpi"><span>Secuencias activas</span><b>' + seqs.length + '</b><small>M≥4.5 últimos 8 días</small></div>' +
    '<div class="card kpi"><span>Réplicas 24 h</span><b>' + reps24 + '</b><small>todas las secuencias</small></div>' +
    '<div class="card kpi"><span>Posibles premonitores</span><b>' + fores + '</b><small>solo se reconocen a posteriori</small></div>' +
    '<div class="card kpi"><span>Mayor sismo (8 d)</span><b>' + (seqs.length ? 'M' + Math.max(...seqs.map((s) => s.mag)).toFixed(1) : '—') + '</b><small>región ampliada</small></div></div>';
  if (!seqs.length) h += '<div class="card empty" style="margin-top:12px">No hay secuencias sísmicas activas.<br><small>Cuando ocurra un sismo M≥4.5 (o uno M≥4 con réplicas) aparecerá aquí con su cuenta de réplicas, línea de tiempo y probabilidades.</small></div>';
  seqs.forEach((m) => {
    const age = (now - m.t) / 864e5, reps = Q.filter((q) => q.main === m.id && q.role === 'after').sort((a, b) => a.t - b.t), fs = Q.filter((q) => q.main === m.id && q.role === 'fore');
    const r24 = reps.filter((q) => now - q.t < 864e5).length, r1 = reps.filter((q) => now - q.t < 3600e3).length, mxr = reps.reduce((a, q) => Math.max(a, q.mag), 0);
    const p = (th) => Math.round(aftershockProb(m.mag, age, th, 1) * 100);
    const trend = reps.length < 3 ? 'datos insuficientes' : (() => { const half = reps.filter((q) => now - q.t < Math.min(age, 2) * 864e5 / 2).length, tot = reps.filter((q) => now - q.t < Math.min(age, 2) * 864e5).length; return half > tot / 2 ? 'ritmo estable o en aumento' : 'ritmo en descenso'; })();
    h += '<div class="card" style="margin-top:12px" data-seq="' + esc(m.id) + '"><div style="display:flex;gap:12px;align-items:center;cursor:pointer" class="seqTop"><div class="mg" style="--c:' + magColor(m.mag) + ';min-width:62px;height:62px;font-size:23px">' + m.mag.toFixed(1) + '</div>' +
      '<div style="min-width:0;flex:1"><b style="display:block">' + esc(placeShort(m.place)) + '</b><small class="note">' + when(m.t) + ' · ' + ago(m.t) + ' · prof. ' + Math.round(m.depth || 0) + ' km</small></div></div>' +
      '<div class="grid g4" style="margin-top:10px"><div class="kpi"><span>Réplicas</span><b>' + reps.length + '</b></div><div class="kpi"><span>Últimas 24 h</span><b>' + r24 + '</b><small>' + r1 + ' en la última hora</small></div><div class="kpi"><span>Mayor réplica</span><b>' + (mxr ? 'M' + mxr.toFixed(1) : '—') + '</b></div><div class="kpi"><span>Premonitores</span><b>' + fs.length + '</b></div></div>' +
      '<canvas class="ch seqCv" data-id="' + esc(m.id) + '" style="margin-top:8px"></canvas>' +
      '<div style="margin-top:8px"><span class="cap">Probabilidad de ≥1 réplica en las próximas 24 h (estimación genérica)</span><div style="margin-top:6px">' +
      [[4, p(4)], [5, p(5)], [6, p(6)]].map((x) => '<div style="display:flex;align-items:center;gap:10px;margin:5px 0"><b class="mono" style="width:44px">≥ M' + x[0] + '</b><div class="bar" style="flex:1"><i style="width:' + Math.max(1, x[1]) + '%;background:' + magColor(x[0] + 0.2) + '"></i></div><b class="mono" style="width:44px;text-align:right">' + (x[1] > 99 ? '>99' : x[1] < 1 ? '<1' : x[1]) + '%</b></div>').join('') + '</div>' +
      '<p class="note" style="margin:6px 0 0">Tendencia: ' + trend + '. Modelo Reasenberg–Jones con parámetros genéricos mundiales: <b>no está calibrado para Panamá</b> y es solo orientativo. Un sismo posterior puede ser mayor que el principal.</p></div>' +
      (reps.length ? '<details class="acc"><summary>Réplicas registradas (' + reps.length + ')</summary><div class="in">' + reps.slice().reverse().slice(0, 40).map((q) => '<div class="ev" data-id="' + esc(q.id) + '"><div class="mg" style="--c:' + magColor(q.mag) + ';min-width:46px;height:46px;font-size:16px">' + q.mag.toFixed(1) + '</div><div class="b"><b>' + esc(placeShort(q.place)) + '</b><small><span>' + ago(q.t) + '</span><span>+' + (((q.t - m.t) / 3600e3) < 48 ? ((q.t - m.t) / 3600e3).toFixed(1) + ' h' : ((q.t - m.t) / 864e5).toFixed(1) + ' d') + ' tras el principal</span><span>' + Math.round(km(m, q)) + ' km</span></small></div></div>').join('') + '</div></details>' : '') +
      '<div class="acts" style="margin-top:10px"><button class="btn sm seqMap">Ver en el mapa</button></div></div>';
  });
  h += '<div class="card" style="margin-top:12px"><h3>Cómo se detectan</h3><ul class="note" style="margin:6px 0;padding-left:18px"><li>Un evento es <b>réplica</b> si es menor que un sismo M≥4 previo, ocurre dentro de su ventana de tiempo y a menos de la distancia de Gardner–Knopoff (p. ej. M5 ≈ 40 km, M6 ≈ 100 km).</li><li>Un <b>posible premonitor</b> es un sismo menor en las 48 h previas y cerca de un sismo M≥4.5; solo se puede reconocer después.</li><li>Tras un sismo fuerte pueden sentirse réplicas durante días o semanas. Mantén tu plan familiar y evita edificios dañados.</li></ul></div></div>';
  root.innerHTML = h;
  $$('#v-replicas .seqCv').forEach((cv) => {
    const m = Q.find((q) => q.id === cv.dataset.id); if (!m) return;
    const reps = Q.filter((q) => q.main === m.id && q.role === 'after').sort((a, b) => a.t - b.t), s = setupCanvas(cv, 96); if (!s) return;
    const { c, w } = s, H = s.h, span = Math.max(now - m.t, 3600e3);
    c.strokeStyle = 'rgba(120,170,200,.2)'; c.beginPath(); c.moveTo(0, H - 18); c.lineTo(w, H - 18); c.stroke();
    const X = (t) => 8 + (w - 16) * (t - m.t) / span, Y = (mg) => H - 20 - (H - 34) * clamp((mg - 1.5) / (m.mag - 1.5 || 1), 0.04, 1);
    c.strokeStyle = magColor(m.mag); c.lineWidth = 3; c.beginPath(); c.moveTo(X(m.t), H - 18); c.lineTo(X(m.t), 6); c.stroke();
    reps.forEach((q) => { c.strokeStyle = magColor(q.mag); c.lineWidth = 2; c.beginPath(); c.moveTo(X(q.t), H - 18); c.lineTo(X(q.t), Y(q.mag)); c.stroke(); c.fillStyle = magColor(q.mag); c.beginPath(); c.arc(X(q.t), Y(q.mag), 3, 0, 7); c.fill(); });
    c.fillStyle = '#7f9bb0'; c.font = '10px ui-monospace,monospace'; c.textAlign = 'left'; c.fillText('principal', 8, H - 5); c.textAlign = 'right'; c.fillText('ahora (+' + (span / 3600e3 < 48 ? (span / 3600e3).toFixed(0) + ' h' : (span / 864e5).toFixed(1) + ' d') + ')', w - 6, H - 5);
  });
  $$('#v-replicas .seqMap').forEach((b) => b.addEventListener('click', () => selectEvent(b.closest('[data-seq]').dataset.seq, true)));
  $$('#v-replicas .seqTop').forEach((b) => b.addEventListener('click', () => selectEvent(b.closest('[data-seq]').dataset.seq, true)));
  $$('#v-replicas .ev').forEach((b) => b.addEventListener('click', () => selectEvent(b.dataset.id, true)));
}

/* ======================= DATOS ======================= */
function renderDatos() {
  const root = $('#v-datos'), now = Date.now(), pan = Q.filter((q) => inBox(q, PAN) && !q.local), all7 = Q.filter((q) => !q.local);
  const per = [], lab = [];
  for (let i = 6; i >= 0; i--) { const a = now - (i + 1) * 864e5, b = now - i * 864e5; per.push(pan.filter((q) => q.t >= a && q.t < b).length); lab.push(i === 0 ? 'hoy' : fDate.format(b - 1).replace('.', '').slice(0, 6)); }
  const mHist = [0, 0, 0, 0, 0, 0], mL = ['<2', '2', '3', '4', '5', '6+']; pan.forEach((q) => { mHist[clamp(Math.floor(q.mag) - 1, 0, 5)]++; });
  const dHist = [0, 0, 0, 0, 0], dL = ['0-10', '10-30', '30-70', '70-150', '150+']; pan.forEach((q) => { const d = q.depth || 0; dHist[d < 10 ? 0 : d < 30 ? 1 : d < 70 ? 2 : d < 150 ? 3 : 4]++; });
  const cum = []; let acc = 0; pan.slice().sort((a, b) => a.t - b.t).forEach((q) => { acc++; cum.push([q.t, acc]); });
  const places = {}; pan.forEach((q) => { const k = placeShort(q.place).replace(/^\d+\s*km\s+(?:al\s+|a\s+el\s+)?\w+\s+de\s+/i, ''); places[k] = (places[k] || 0) + 1; });
  const top = Object.keys(places).sort((a, b) => places[b] - places[a]).slice(0, 6);
  const en = pan.reduce((a, q) => a + energyJ(q.mag), 0), tnt = en / 4.184e9, bv = bEst(pan.map((q) => q.mag));
  const mx = pan.reduce((m, q) => (!m || q.mag > m.mag ? q : m), null), ps = panStats();
  const mean = pan.length / 7;
  let h = '<div class="wrap">' + head('DATOS Y ESTADÍSTICAS', 'Resumen de Panamá y mar adyacente · últimos 8 días del catálogo unificado') +
    '<div class="grid g4"><div class="card kpi"><span>Panamá 24 h</span><b>' + ps.n24 + '</b><small>actividad ' + ps.act.toLowerCase() + '</small></div>' +
    '<div class="card kpi"><span>Panamá 7 d</span><b>' + ps.n7 + '</b><small>≈ ' + mean.toFixed(1) + ' por día</small></div>' +
    '<div class="card kpi"><span>Mayor</span><b>' + (mx ? 'M' + mx.mag.toFixed(1) : '—') + '</b><small>' + (mx ? esc(placeShort(mx.place)).slice(0, 34) : 'sin eventos') + '</small></div>' +
    '<div class="card kpi"><span>Energía liberada</span><b>' + (tnt >= 1e3 ? (tnt / 1e3).toFixed(1) + ' kt' : tnt.toFixed(1) + ' t') + '</b><small>equivalente en TNT (orden de magnitud)</small></div></div>' +
    '<div class="grid g2" style="margin-top:12px"><div class="card"><h3>Sismos por día (Panamá)</h3><canvas class="ch" id="chDay"></canvas></div><div class="card"><h3>Acumulado en 8 días</h3><canvas class="ch" id="chCum"></canvas></div>' +
    '<div class="card"><h3>Magnitudes</h3><canvas class="ch" id="chMag"></canvas></div><div class="card"><h3>Profundidad (km)</h3><canvas class="ch" id="chDep"></canvas></div></div>' +
    '<div class="grid g2" style="margin-top:12px"><div class="card"><h3>Zonas más activas</h3>' + (top.length ? top.map((k) => '<div style="display:flex;align-items:center;gap:10px;margin:7px 0"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(k) + '</span><div class="bar" style="width:38%"><i style="width:' + Math.round(100 * places[k] / places[top[0]]) + '%"></i></div><b class="mono" style="width:30px;text-align:right">' + places[k] + '</b></div>').join('') : '<div class="empty">Sin datos</div>') + '</div>' +
    '<div class="card"><h3>Ley de Gutenberg–Richter</h3>' + (bv ? '<div class="kpi" style="padding:0"><b>b = ' + bv.b.toFixed(2) + '</b><small>Mc ≈ ' + bv.mc.toFixed(1) + ' · ' + bv.n + ' eventos</small></div><p class="note">Un valor cercano a 1 es típico. Con pocos días de datos la incertidumbre es grande; es solo informativo.</p>' : '<p class="note">Se necesitan al menos ~30 eventos para estimar b. Ahora hay ' + pan.length + '.</p>') + '</div></div>' +
    '<div class="card" style="margin-top:12px"><h3>Estado de las fuentes</h3><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="color:var(--mut);text-align:left"><th style="padding:6px">Fuente</th><th>Estado</th><th>Eventos</th><th>Latencia</th><th>Detalle</th></tr>' +
    ['IGC', 'USGS', 'EMSC'].map((n) => { const s = SRC[n]; return '<tr style="border-top:1px solid var(--line)"><td style="padding:8px 6px"><b>' + (n === 'IGC' ? 'IGC-UP' : n) + '</b></td><td>' + (!s ? '—' : s.ok ? (s.stale ? '<span class="tag pre">guardado</span>' : '<span class="tag rev">en línea</span>') : '<span class="tag" style="color:var(--red);border-color:var(--red)">caído</span>') + '</td><td class="mono">' + (s ? s.n : '—') + '</td><td class="mono">' + (s && s.ms != null ? s.ms + ' ms' : '—') + '</td><td class="note">' + esc(s ? (s.err || (s.at ? 'actualizado ' + ago(s.at) : '')) : '') + '</td></tr>'; }).join('') +
    '<tr style="border-top:1px solid var(--line)"><td style="padding:8px 6px"><b>EN VIVO (WS)</b></td><td>' + (wsOn ? '<span class="tag rev">conectado</span>' : '<span class="tag pre">sondeo</span>') + '</td><td class="mono">' + wsQ.length + '</td><td>—</td><td class="note">EMSC SeismicPortal</td></tr></table></div>' +
    '<p class="note" style="margin-bottom:0">Prioridad de datos al fusionar: IGC-UP (red nacional) &gt; USGS &gt; EMSC. Las magnitudes del IGC son locales y pueden diferir de las de USGS (Mw). Eventos totales en catálogo: ' + all7.length + '.</p></div></div>';
  root.innerHTML = h;
  barChart($('#chDay'), per, lab, '#27f0c4', 150);
  lineChart($('#chCum'), cum, 150, '#4fc3f7');
  barChart($('#chMag'), mHist, mL, (i) => magColor(i + 1.4), 140);
  barChart($('#chDep'), dHist, dL, '#ffb020', 140);
}

/* ======================= GUÍA ======================= */
const KIT = ['Agua: 3 litros por persona por día (mínimo 3 días)', 'Alimentos no perecederos y abrelatas', 'Botiquín de primeros auxilios y medicinas personales', 'Linterna con baterías de repuesto', 'Radio a pilas o manivela', 'Silbato para pedir ayuda', 'Cargador portátil (power bank) cargado', 'Copias de documentos en bolsa hermética', 'Efectivo en billetes pequeños', 'Ropa abrigadora, calzado cerrado y mascarilla', 'Artículos para bebés, adultos mayores y mascotas', 'Lista de teléfonos de emergencia impresa'];
const MERC = [['I', 'No se siente', '#5f7a8f'], ['II-III', 'Sentido por pocos en reposo; objetos colgantes oscilan', '#27f0c4'], ['IV', 'Sentido en interiores; vibran ventanas y vajilla', '#7ff6dd'], ['V', 'Casi todos lo sienten; objetos pequeños se mueven', '#ffd166'], ['VI', 'Sentido por todos; cae yeso y se mueven muebles', '#ffb020'], ['VII', 'Difícil mantenerse de pie; daños leves en edificios bien construidos', '#ff9f43'], ['VIII', 'Daños considerables en estructuras ordinarias', '#ff4d6d'], ['IX+', 'Daños graves o colapso de estructuras', '#ff2bd6']];
function renderGuia() {
  const root = $('#v-guia'), kit = LS.get('kit', []), contacts = LS.get('contacts', []);
  root.innerHTML = '<div class="wrap">' + head('GUÍA DE SEGURIDAD', 'Prepárate antes, protégete durante, actúa después. Información general; sigue siempre las instrucciones de SINAPROC.') +
    '<div class="card" style="border-color:rgba(255,77,109,.5)"><h3 style="color:#ffb3c0">DURANTE UN TEMBLOR: AGÁCHATE · CÚBRETE · SUJÉTATE</h3><p style="margin:6px 0 0">Bajo una mesa resistente o junto a una pared interior, protegiendo cabeza y cuello. No corras ni uses ascensores. Aléjate de ventanas y objetos que caen.</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><a class="btn dng" href="tel:911">Llamar al 911</a><button class="btn" id="gDrill">Simulacro de alarma</button></div></div>' +
    '<details class="acc" open><summary>Antes del sismo</summary><div class="in"><ul><li>Identifica zonas seguras en casa y trabajo, y rutas de salida.</li><li>Fija estantes, televisores y objetos pesados; guarda lo pesado abajo.</li><li>Aprende a cerrar gas, agua y electricidad.</li><li>Acuerda un punto de reunión y un contacto fuera de la ciudad.</li><li>Prepara la mochila de emergencia (abajo) y haz simulacros.</li></ul></div></details>' +
    '<details class="acc"><summary>Durante el sismo</summary><div class="in"><ul><li><b>Adentro:</b> agáchate, cúbrete bajo una mesa firme y sujétate hasta que pare. Quédate dentro.</li><li><b>Afuera:</b> aléjate de edificios, postes y cables; busca un espacio abierto.</li><li><b>Conduciendo:</b> detente lejos de puentes y árboles; permanece en el vehículo.</li><li><b>Cerca de la costa:</b> si el temblor es fuerte o largo, sube a terreno elevado sin esperar aviso.</li></ul></div></details>' +
    '<details class="acc"><summary>Después del sismo</summary><div class="in"><ul><li>Revisa si hay heridos; presta primeros auxilios. No muevas a heridos graves.</li><li>Espera réplicas: vuelve a agacharte, cubrirte y sujetarte.</li><li>Si hueles gas, abre ventanas, no uses fuego ni interruptores y sal.</li><li>Usa mensajes de texto en lugar de llamadas para no saturar la red.</li><li>Evita edificios dañados. Infórmate por canales oficiales.</li></ul></div></details>' +
    '<details class="acc"><summary>Tsunami</summary><div class="in"><ul><li>Señales naturales: temblor fuerte o prolongado, retirada brusca del mar, ruido inusual del océano.</li><li>Aléjate de la costa hacia terreno alto <b>de inmediato</b>; no esperes confirmación.</li><li>Permanece lejos hasta que las autoridades indiquen que es seguro: pueden llegar varias olas.</li><li>Esta app muestra un aviso si la fuente (USGS) lo asocia, pero <b>no es un sistema de alerta de tsunami</b>.</li></ul></div></details>' +
    '<div class="card" style="margin-top:12px"><h3>Mochila de emergencia</h3><div id="kitList">' + KIT.map((k, i) => '<div class="chk' + (kit.includes(i) ? ' on' : '') + '" data-i="' + i + '"><i>✓</i><span>' + esc(k) + '</span></div>').join('') + '</div><div class="bar" style="margin-top:8px"><i id="kitBar" style="width:0"></i></div><p class="note" id="kitTxt" style="margin:6px 0 0"></p></div>' +
    '<div class="card" style="margin-top:12px"><h3>Plan familiar · contactos</h3><div id="ctList"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><input type="text" id="ctN" placeholder="Nombre" style="flex:1;min-width:110px;max-width:none"><input type="tel" id="ctT" placeholder="Teléfono" style="flex:1;min-width:110px;max-width:none"><button class="btn pri sm" id="ctAdd">Añadir</button></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn" id="ctSafe">Enviar “Estoy bien” con mi ubicación</button></div><p class="note" style="margin:6px 0 0">Los contactos se guardan solo en este dispositivo.</p></div>' +
    '<div class="card" style="margin-top:12px"><h3>Escala Mercalli (intensidad sentida)</h3>' + MERC.map((m) => '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)"><b class="mono" style="min-width:52px;color:' + m[2] + '">' + m[0] + '</b><span style="color:#b9cddb">' + m[1] + '</span></div>').join('') + '<p class="note" style="margin:8px 0 0">La magnitud mide la energía en el origen; la intensidad mide el efecto en cada lugar y baja con la distancia.</p></div>' +
    '<div class="card" style="margin-top:12px"><h3>Emergencias y fuentes oficiales</h3><div class="row"><div class="t"><b>Emergencias 911</b><small>Policía, bomberos, ambulancia</small></div><a class="btn sm" href="tel:911">Llamar</a></div>' +
    '<div class="row"><div class="t"><b>SINAPROC</b><small>Sistema Nacional de Protección Civil · verifica el número vigente en su sitio</small></div><a class="btn sm" target="_blank" rel="noopener" href="https://www.sinaproc.gob.pa/">Sitio ↗</a></div>' +
    '<div class="row"><div class="t"><b>Instituto de Geociencias (IGC-UP)</b><small>Red sismológica nacional</small></div><a class="btn sm" target="_blank" rel="noopener" href="https://sismosgeociencias.up.ac.pa/">Sitio ↗</a></div>' +
    '<div class="row"><div class="t"><b>USGS Earthquake Hazards</b><small>Catálogo mundial</small></div><a class="btn sm" target="_blank" rel="noopener" href="https://earthquake.usgs.gov/earthquakes/map/">Mapa ↗</a></div>' +
    '<div class="row"><div class="t"><b>EMSC</b><small>Centro Sismológico Euro-Mediterráneo</small></div><a class="btn sm" target="_blank" rel="noopener" href="https://www.emsc-csem.org/">Sitio ↗</a></div></div>' +
    '<div class="warnbox" style="margin-top:12px"><b>Importante:</b> esta app informa sismos <i>después</i> de que ocurren, con segundos a minutos de retraso. No es un sistema oficial de alerta temprana ni predice terremotos. No sustituye las instrucciones de las autoridades.</div></div>';
  const kitUpd = () => { const k = LS.get('kit', []); $('#kitBar').style.width = Math.round(100 * k.length / KIT.length) + '%'; $('#kitTxt').textContent = k.length + ' de ' + KIT.length + ' listo(s)'; };
  $('#kitList').addEventListener('click', (e) => { const r = e.target.closest('.chk'); if (!r) return; const i = +r.dataset.i, k = LS.get('kit', []), j = k.indexOf(i); if (j >= 0) k.splice(j, 1); else k.push(i); LS.set('kit', k); r.classList.toggle('on'); kitUpd(); });
  kitUpd();
  const drawCt = () => {
    const c = LS.get('contacts', []);
    $('#ctList').innerHTML = c.length ? c.map((x, i) => '<div class="row"><div class="t"><b>' + esc(x.n) + '</b><small>' + esc(x.tel) + '</small></div><div style="display:flex;gap:6px"><a class="btn sm" href="tel:' + esc(x.tel) + '">Llamar</a><a class="btn sm" href="sms:' + esc(x.tel) + '">SMS</a><button class="btn sm dng" data-del="' + i + '">✕</button></div></div>').join('') : '<p class="note">Aún no hay contactos. Añade a tu familia.</p>';
    $$('#ctList [data-del]').forEach((b) => b.addEventListener('click', () => { const c2 = LS.get('contacts', []); c2.splice(+b.dataset.del, 1); LS.set('contacts', c2); drawCt(); }));
  };
  drawCt();
  $('#ctAdd').addEventListener('click', () => { const n = $('#ctN').value.trim(), t = $('#ctT').value.trim(); if (!n || !/[\d]{4,}/.test(t)) { toast('Escribe nombre y teléfono válido', '', 'warn'); return; } const c = LS.get('contacts', []); c.push({ n, tel: t.replace(/[^\d+]/g, '') }); LS.set('contacts', c.slice(0, 12)); $('#ctN').value = ''; $('#ctT').value = ''; drawCt(); });
  $('#ctSafe').addEventListener('click', () => {
    const c = LS.get('contacts', []), msg = 'Estoy bien tras el sismo. Mi ubicación: https://maps.google.com/?q=' + user.lat.toFixed(5) + ',' + user.lon.toFixed(5);
    if (c.length) location.href = 'sms:' + c.map((x) => x.tel).join(',') + (isIOS ? '&' : '?') + 'body=' + encodeURIComponent(msg);
    else if (navigator.share) navigator.share({ text: msg }).catch(() => { }); else toast('Añade contactos primero', '', 'warn');
  });
  $('#gDrill').addEventListener('click', () => { if (confirm('Se activará una alarma de PRÁCTICA con sonido y vibración. ¿Continuar?')) { Snd.init(); drill(); } });
}

/* ======================= AJUSTES ======================= */
function renderAjustes() {
  const root = $('#v-ajustes'), st = sensorState();
  const sw = (id, on, title, sub) => '<div class="row"><div class="t"><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div><button class="sw' + (on ? ' on' : '') + '" id="' + id + '" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(title) + '"></button></div>';
  const sl = (id, val, min, max, step, title, sub, fmt) => '<div class="row"><div class="t"><b>' + title + '</b><small>' + sub + '</small></div><div style="display:flex;align-items:center;gap:8px"><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"><b class="mono" id="' + id + 'V" style="min-width:42px;text-align:right">' + fmt(val) + '</b></div></div>';
  const ep = [['/api/quakes', 'Eventos unificados (JSON)'], ['/api/quakes.geojson', 'Eventos en GeoJSON'], ['/api/igc', 'Solo IGC-UP, convertido a API'], ['/api/latest', 'Último evento'], ['/api/stats', 'Estadísticas'], ['/api/sequences', 'Secuencias y réplicas'], ['/api/status', 'Estado del sistema'], ['/api', 'Documentación']];
  root.innerHTML = '<div class="wrap">' + head('AJUSTES', 'Todo se guarda en este dispositivo.') +
    '<div class="card"><h3>Tu ubicación</h3><div class="row"><div class="t"><b>Ciudad de referencia</b><small>Para distancias, llegada de ondas y niveles de alerta</small></div><select id="sCity">' + CITIES.map((c) => '<option value="' + c[0] + '"' + (cfg.city === c[0] ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('') + '<option value="gps"' + (cfg.city === 'gps' ? ' selected' : '') + '>Mi GPS</option></select></div>' +
    '<div class="row"><div class="t"><b>Usar GPS ahora</b><small>' + (cfg.city === 'gps' && LS.get('gpsPos', null) ? 'Posición guardada ' + LS.get('gpsPos').lat.toFixed(3) + ', ' + LS.get('gpsPos').lon.toFixed(3) : 'Pide permiso de ubicación') + '</small></div><button class="btn sm" id="sGps">Ubicarme</button></div></div>' +
    '<div class="card"><h3>Alertas</h3>' + sl('sM1', cfg.m1, 2.5, 6, 0.5, 'Avisar desde', 'Magnitud mínima para sismos en Panamá', (v) => 'M' + (+v).toFixed(1)) + sl('sM2', cfg.m2, 4, 7, 0.5, 'Alerta fuerte desde', 'Sirena y pantalla completa (M mundial: cercano)', (v) => 'M' + (+v).toFixed(1)) +
    '<div class="row"><div class="t"><b>Alarma a pantalla completa</b><small>Nivel mínimo que abre la alarma</small></div><select id="sFull"><option value="1"' + (cfg.full == 1 ? ' selected' : '') + '>Informativo</option><option value="2"' + (cfg.full == 2 ? ' selected' : '') + '>Alerta</option><option value="3"' + (cfg.full == 3 ? ' selected' : '') + '>Solo peligro</option></select></div>' +
    sw('sRep', cfg.replicas, 'Avisar réplicas', 'Notifica réplicas relevantes de una secuencia') + '</div>' +
    '<div class="card"><h3>Notificaciones</h3><div class="row"><div class="t"><b>Permiso del navegador</b><small id="sNotifT">' + (('Notification' in window) ? (Notification.permission === 'granted' ? 'Concedido' : Notification.permission === 'denied' ? 'Bloqueado: actívalo en los ajustes del sitio' : 'Sin conceder') : 'No disponible') + '</small></div><button class="btn sm" id="sNotif">Permitir</button></div>' +
    sw('sPersist', cfg.persist, 'Notificación persistente', 'Monitor fijo en la barra mientras la app está abierta') +
    '<div class="row"><div class="t"><b>Push con la app cerrada</b><small id="sPushT">Comprobando…</small></div><div style="display:flex;gap:6px"><button class="btn sm pri" id="sPush">Activar</button><button class="btn sm" id="sPushTest">Probar</button></div></div></div>' +
    '<div class="card"><h3>Sonido y voz</h3>' + sw('sSound', cfg.sound, 'Sonidos', 'Sintetizados en el dispositivo, sin descargar archivos') + sl('sVol', cfg.vol, 0.1, 1, 0.05, 'Volumen', 'Volumen maestro de alertas', (v) => Math.round(v * 100) + '%') +
    '<div class="row"><div class="t"><b>Perfil de sonido</b><small>Estilo de las alertas</small></div><select id="sProf"><option value="istmo"' + (cfg.profile === 'istmo' ? ' selected' : '') + '>Istmo (sonar + arpegio)</option><option value="clasico"' + (cfg.profile === 'clasico' ? ' selected' : '') + '>Clásico (dos tonos)</option><option value="suave"' + (cfg.profile === 'suave' ? ' selected' : '') + '>Suave (campanas)</option></select></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 0">' + SOUND_LIST.map((s) => '<button class="btn sm" data-snd="' + s[0] + '" title="' + esc(s[2]) + '">▶ ' + s[1] + '</button>').join('') + '<button class="btn sm dng" id="sSiren">▶ Sirena (5 s)</button></div>' +
    sw('sVoice', cfg.voice, 'Voz', 'Lee la alerta en español') + sw('sVib', cfg.vib, 'Vibración', 'Patrones según el nivel (Android)') + '</div>' +
    '<div class="card"><h3>Detector de movimiento</h3>' + sw('sSensor', cfg.sensor, 'Acelerómetro del equipo', 'Detecta sacudidas con el equipo quieto (STA/LTA). Útil con el teléfono apoyado.') +
    '<div class="row"><div class="t"><b>Estado</b><small id="sSensT">' + esc(st[1]) + '</small></div><button class="btn sm" id="sSensGo">Activar sensor</button></div>' +
    '<div class="row"><div class="t"><b>Sensibilidad</b><small>Más alta = detecta más pero con más falsas alarmas</small></div><select id="sSens"><option value="1"' + (cfg.sens == 1 ? ' selected' : '') + '>Baja</option><option value="2"' + (cfg.sens == 2 ? ' selected' : '') + '>Media</option><option value="3"' + (cfg.sens == 3 ? ' selected' : '') + '>Alta</option></select></div><canvas class="ch" id="sTrace" style="height:60px"></canvas></div>' +
    '<div class="card"><h3>Pantalla</h3>' + sw('sWake', cfg.wake, 'Mantener pantalla encendida', 'Wake Lock mientras la app está visible') + sw('sKiosk', cfg.kiosk, 'Modo quiosco', 'Oculta menús y deja solo el radar') + sw('sDim', cfg.dim, 'Atenuar pantalla', 'Oscurece para dejarla encendida de noche') +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:10px"><button class="btn" id="sFs">Pantalla completa</button><button class="btn pri" id="sInst">' + (isStandalone() ? 'App instalada ✓' : 'Instalar app') + '</button></div></div>' +
    '<div class="card"><h3>Datos</h3><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="sCsv">Exportar CSV</button><button class="btn sm" id="sGj">Exportar GeoJSON</button><button class="btn sm" id="sRef">Actualizar ahora</button><button class="btn sm dng" id="sClr">Borrar datos locales</button></div>' +
    '<h3 style="margin-top:16px">API pública</h3>' + ep.map((e) => '<div class="row"><div class="t"><b class="mono" style="font-size:13px">' + e[0] + '</b><small>' + e[1] + '</small></div><div style="display:flex;gap:6px"><a class="btn sm" target="_blank" href="' + e[0] + '">Abrir</a><button class="btn sm" data-copy="' + e[0] + '">Copiar</button></div></div>').join('') + '</div>' +
    '<div class="card" style="text-align:center"><b style="letter-spacing:.2em">ISTMO · SISMO PANAMÁ</b><p class="note" style="margin:6px 0">Fuentes: IGC-UP, USGS, EMSC · mapas CARTO/OSM/Esri<br>Versión <span class="mono" id="sVer">…</span></p><a class="btn" target="_blank" rel="noopener" href="https://instagram.com/elprotectorado">By @elprotectorado</a></div></div>';
  const on = (id, fn) => { const e = $('#' + id); if (e) e.addEventListener('click', fn); };
  const tg = (id, key, cb) => on(id, () => { cfg[key] = !cfg[key]; $('#' + id).classList.toggle('on', cfg[key]); $('#' + id).setAttribute('aria-checked', cfg[key]); saveCfg(); applyDisplay(); if (cb) cb(); });
  const rg = (id, key, fmt) => $('#' + id).addEventListener('input', (e) => { cfg[key] = +e.target.value; $('#' + id + 'V').textContent = fmt(cfg[key]); saveCfg(); });
  $('#sCity').addEventListener('change', async (e) => {
    cfg.city = e.target.value; if (cfg.city === 'gps') { const ok = await gpsFix(); if (!ok) { cfg.city = 'pty'; } } saveCfg(); renderAll(); renderAjustes();
  });
  on('sGps', async () => { const ok = await gpsFix(); if (ok) { cfg.city = 'gps'; saveCfg(); renderAll(); renderAjustes(); toast('Ubicación actualizada', userName(), 'good'); } });
  rg('sM1', 'm1', (v) => 'M' + v.toFixed(1)); rg('sM2', 'm2', (v) => 'M' + v.toFixed(1)); rg('sVol', 'vol', (v) => Math.round(v * 100) + '%');
  $('#sFull').addEventListener('change', (e) => { cfg.full = +e.target.value; saveCfg(); });
  $('#sProf').addEventListener('change', (e) => { cfg.profile = e.target.value; saveCfg(); Snd.init(); Snd.play('alert'); });
  $('#sSens').addEventListener('change', (e) => { cfg.sens = +e.target.value; saveCfg(); });
  tg('sRep', 'replicas'); tg('sSound', 'sound', () => { if (cfg.sound) Snd.init(); }); tg('sVoice', 'voice'); tg('sVib', 'vib', () => { if (cfg.vib) vib(80); });
  tg('sPersist', 'persist', () => { cfg.persist ? persistNote() : clearPersist(); });
  tg('sSensor', 'sensor', () => sensorStart(true)); tg('sWake', 'wake', () => { cfg.wake ? wakeLock() : (wl && wl.release().catch(() => { })); });
  tg('sKiosk', 'kiosk'); tg('sDim', 'dim');
  on('sNotif', async () => { const p = await ensureNotifPerm(); const t = $('#sNotifT'); if (t) t.textContent = p === 'granted' ? 'Concedido' : p === 'denied' ? 'Bloqueado: actívalo en los ajustes del sitio' : 'Sin conceder'; if (p === 'granted') persistNote(); });
  on('sSensGo', async () => { const ok = await sensorStart(true); toast(ok ? 'Sensor activado' : 'Sensor no disponible', ok ? 'Apoya el equipo y déjalo quieto 8 s para armarlo' : 'Este equipo no ofrece acelerómetro o se negó el permiso', ok ? 'good' : 'warn'); });
  on('sFs', toggleFs); on('sInst', doInstall);
  on('sPush', async () => { if (pushInfo.sub) await pushDisable(); else await pushEnable(); renderAjustes(); }); on('sPushTest', pushTest);
  $$('#v-ajustes [data-snd]').forEach((b) => b.addEventListener('click', () => { Snd.init(); const was = cfg.sound; cfg.sound = true; Snd.apply(); Snd.play(b.dataset.snd); cfg.sound = was; if (!was) setTimeout(Snd.apply, 2500); vib(120); }));
  on('sSiren', () => { Snd.init(); const was = cfg.sound; cfg.sound = true; Snd.apply(); Snd.startSiren(); setTimeout(() => { Snd.stopSiren(); cfg.sound = was; Snd.apply(); }, 5000); });
  on('sCsv', () => exportData('csv')); on('sGj', () => exportData('geojson')); on('sRef', () => { poll(true); toast('Actualizando…', '', '', 1500); });
  on('sClr', () => { if (confirm('¿Borrar configuración, contactos y datos guardados en este dispositivo?')) { try { Object.keys(localStorage).filter((k) => k.indexOf('istmo.') === 0).forEach((k) => localStorage.removeItem(k)); caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))); } catch (e) { } location.reload(); } });
  $$('#v-ajustes [data-copy]').forEach((b) => b.addEventListener('click', async () => { const u = location.origin + b.dataset.copy; try { await navigator.clipboard.writeText(u); toast('Copiado', u, 'good', 2500); } catch (e) { toast(u, '', '', 6000); } }));
  fetch('/api/status').then((r) => r.json()).then((j) => { const v = $('#sVer'); if (v) v.textContent = j.version; }).catch(() => { });
  pushCheck().then((p) => {
    const t = $('#sPushT'), b = $('#sPush'), bt = $('#sPushTest'); if (!t) return;
    if (!p.supported) { t.textContent = 'No soportado en este navegador (iPhone: instala la app y usa iOS 16.4+)'; b.disabled = true; bt.disabled = true; return; }
    if (p.kv === false) { t.textContent = 'El servidor aún no tiene KV (SISMO_KV) enlazado. Ver /api'; b.disabled = true; bt.disabled = true; return; }
    if (p.kv === null) { t.textContent = 'No se pudo consultar el servidor'; return; }
    t.textContent = p.sub ? 'Activo: recibirás avisos con la app cerrada' : 'Inactivo'; b.textContent = p.sub ? 'Desactivar' : 'Activar'; bt.disabled = !p.sub;
  });
}
function gpsFix() {
  return new Promise((res) => {
    if (!navigator.geolocation) { toast('GPS no disponible', '', 'warn'); res(false); return; }
    navigator.geolocation.getCurrentPosition((p) => { LS.set('gpsPos', { lat: p.coords.latitude, lon: p.coords.longitude }); cfg.lat = p.coords.latitude; cfg.lon = p.coords.longitude; res(true); },
      (e) => { toast('No se pudo obtener la ubicación', e.code === 1 ? 'Permiso denegado' : 'Intenta de nuevo', 'warn'); res(false); }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  });
}
function liveAjustes() {
  const t = $('#sSensT'); if (t) { const s = sensorState(); t.textContent = s[1]; }
  const cv = $('#sTrace'); if (!cv) return; const s = setupCanvas(cv, 60); if (!s) return; const { c, w } = s, n = SN.trace.length;
  c.strokeStyle = '#27f0c4'; c.lineWidth = 1.5; c.beginPath();
  for (let i = 0; i < n; i++) { const v = SN.trace[(SN.ti + i) % n], x = w * i / (n - 1), y = 56 - Math.min(52, v * 30); i ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke();
}
