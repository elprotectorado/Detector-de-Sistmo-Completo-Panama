/* ======================================================================
   Parte 3 · mapa (Leaflet), sismograma, tarjeta principal y detalle
   ====================================================================== */
let map = null, baseLayer = null, gQ, gLinks, gWaves, gHeat, gUser, gSel, selQ = null;
const waveSet = new Map();
const TILES = {
  dark: { name: 'Oscuro', u: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', o: { subdomains: 'abcd', maxZoom: 19, attribution: '© OpenStreetMap · © CARTO' } },
  sat: { name: 'Satélite', u: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', o: { maxZoom: 18, attribution: 'Imágenes © Esri' } },
  street: { name: 'Calles', u: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', o: { maxZoom: 19, attribution: '© OpenStreetMap' } },
  topo: { name: 'Relieve', u: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', o: { subdomains: 'abc', maxZoom: 17, attribution: '© OpenTopoMap' } }
};
const OUTLINE = [[-82.9, 8.05], [-82.2, 8.2], [-81.7, 8.15], [-81.2, 7.6], [-80.9, 7.45], [-80.45, 7.25], [-80.0, 7.5], [-80.1, 7.9], [-79.9, 8.3], [-79.5, 8.95], [-78.9, 8.6], [-78.4, 8.0], [-77.8, 7.7], [-77.2, 8.0], [-77.35, 8.67], [-77.9, 9.2], [-78.9, 9.55], [-79.9, 9.35], [-80.5, 9.1], [-81.0, 8.85], [-81.8, 9.1], [-82.5, 9.55], [-82.9, 9.0], [-82.9, 8.5]];
const RANGES = { '1h': 3600e3, '24h': 864e5, '7d': 8 * 864e5 };
const MINS = [0, 2.5, 3.5, 4.5, 5.5];

function visibleQ() {
  const now = Date.now(), r = RANGES[cfg.range] || 864e5;
  return Q.filter((q) => now - q.t < r && q.mag >= cfg.minMag && (!cfg.onlyPan || inBox(q, PAN)));
}
function depthClass(d) { return d < 70 ? 'superficial' : d < 300 ? 'intermedio' : 'profundo'; }
const ROLE_TXT = { main: 'Sismo principal con secuencia', after: 'Réplica', fore: 'Posible premonitor', single: 'Evento aislado' };

/* ---------- Mapa ---------- */
function initMap() {
  buildMapUI();
  if (typeof L === 'undefined') { $('#map').classList.add('hide'); const fb = $('#mapfb'); fb.classList.remove('hide'); fb.addEventListener('click', fbClick); toast('Mapa detallado no disponible', 'Usando el mapa esquemático (sin conexión a la librería de mapas)', 'warn', 6000); return; }
  map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 3, maxZoom: 17, zoomSnap: 0.25, attributionControl: true });
  setBase(cfg.map);
  gHeat = L.layerGroup().addTo(map); gLinks = L.layerGroup().addTo(map); gQ = L.layerGroup().addTo(map); gWaves = L.layerGroup().addTo(map); gUser = L.layerGroup().addTo(map); gSel = L.layerGroup().addTo(map);
  map.on('click', () => closeSheet());
  fitPanama(true);
}
function setBase(k) {
  if (!map) return; const t = TILES[k] || TILES.dark;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(t.u, Object.assign({ crossOrigin: true }, t.o)).addTo(map); baseLayer.bringToBack();
}
function fitPanama(instant) { if (map) map.fitBounds([[5.2, -83.8], [10.2, -76.8]], { padding: [24, 24], animate: !instant }); else drawFallback(); }
function locateMe() {
  if (!navigator.geolocation) { toast('Sin geolocalización', 'Este navegador no la soporta', 'warn'); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    cfg.city = 'gps'; user = { lat: p.coords.latitude, lon: p.coords.longitude }; LS.set('gpsPos', user); saveCfg();
    if (map) map.flyTo([user.lat, user.lon], 9, { duration: 0.9 }); renderAll(); toast('Ubicación actualizada', 'Las distancias y alertas usan tu posición', 'good');
  }, () => toast('No se pudo obtener tu ubicación', 'Permite el acceso o elige una ciudad en Ajustes', 'warn', 6000), { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
}
function drawMap() {
  if (!map) { drawFallback(); return; }
  gQ.clearLayers(); gLinks.clearLayers(); gHeat.clearLayers(); gUser.clearLayers(); gSel.clearLayers(); gWaves.clearLayers(); waveSet.clear();
  const now = Date.now(), list = visibleQ().slice().reverse(), byId = {}; Q.forEach((q) => { byId[q.id] = q; });
  if (cfg.heat) list.forEach((q) => L.circle([q.lat, q.lon], { radius: Math.max(9000, feltKm(q.mag) * 150), stroke: false, fillColor: '#ff4d6d', fillOpacity: 0.07, interactive: false }).addTo(gHeat));
  if (cfg.links) list.forEach((q) => { const m = q.role === 'after' && byId[q.main]; if (m) L.polyline([[m.lat, m.lon], [q.lat, q.lon]], { color: '#ffb020', weight: 1.2, opacity: 0.4, dashArray: '4 5', interactive: false }).addTo(gLinks); });
  let pulses = 0;
  list.forEach((q) => {
    const col = magColor(q.mag), age = now - q.t, op = age < 3600e3 ? 0.95 : age < 864e5 ? 0.78 : 0.5, r = 3.5 + q.mag * 2.3;
    const mk = L.circleMarker([q.lat, q.lon], { radius: r, color: col, weight: q.id === SEL ? 3.5 : 1.4, fillColor: col, fillOpacity: op * 0.4, opacity: op });
    mk.on('click', (e) => { L.DomEvent.stopPropagation(e); selectEvent(q.id); });
    mk.bindTooltip('<b>M' + q.mag.toFixed(1) + '</b> · ' + esc(placeShort(q.place)) + '<br>' + ago(q.t), { direction: 'top', opacity: 1 });
    mk.addTo(gQ);
    if (age < 1800e3 && q.mag >= 3 && pulses++ < 10) L.marker([q.lat, q.lon], { icon: L.divIcon({ className: '', html: '<div class="pulse" style="--c:' + col + '"><i></i><i></i></div>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(gQ);
    if (cfg.waves && age < 12 * 60e3 && q.mag >= 3) {
      const cp = L.circle([q.lat, q.lon], { radius: 1, color: '#4fc3f7', weight: 1.5, fill: false, opacity: 0.85, interactive: false }).addTo(gWaves);
      const cs = L.circle([q.lat, q.lon], { radius: 1, color: '#ff4d6d', weight: 2, fill: true, fillColor: '#ff4d6d', fillOpacity: 0.05, opacity: 0.9, interactive: false }).addTo(gWaves);
      waveSet.set(q.id, { q, cp, cs });
    }
  });
  const sq = Q.find((q) => q.id === SEL);
  if (sq) L.circle([sq.lat, sq.lon], { radius: feltKm(sq.mag) * 1000, color: magColor(sq.mag), weight: 1, dashArray: '7 7', fillOpacity: 0.035, interactive: false }).addTo(gSel);
  L.marker([user.lat, user.lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, keyboard: false, zIndexOffset: 900 }).addTo(gUser);
  tickWaves();
}
function tickWaves() {
  if (!map || !waveSet.size) return; const now = Date.now();
  waveSet.forEach((w) => { const age = Math.max(0, (now - w.q.t) / 1000); w.cp.setRadius(Math.max(1, VP * age * 1000)); w.cs.setRadius(Math.max(1, VS * age * 1000)); });
}
/* Mapa esquemático de respaldo (sin Leaflet) */
function drawFallback() {
  const cv = $('#mapfb'); if (!cv || cv.classList.contains('hide')) return;
  const w = cv.clientWidth || 600, h = cv.clientHeight || 400, dpr = window.devicePixelRatio || 1; cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const B = { minlat: 4.5, maxlat: 11, minlon: -84.5, maxlon: -75.5 }, sc = Math.min(w / (B.maxlon - B.minlon), h / (B.maxlat - B.minlat)), ox = (w - sc * (B.maxlon - B.minlon)) / 2, oy = (h - sc * (B.maxlat - B.minlat)) / 2;
  const X = (lon) => ox + (lon - B.minlon) * sc, Y = (lat) => oy + (B.maxlat - lat) * sc; cv._t = { X, Y };
  c.fillStyle = '#07121d'; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(120,190,230,.12)'; for (let la = 5; la <= 11; la++) { c.beginPath(); c.moveTo(0, Y(la)); c.lineTo(w, Y(la)); c.stroke(); } for (let lo = -84; lo <= -76; lo++) { c.beginPath(); c.moveTo(X(lo), 0); c.lineTo(X(lo), h); c.stroke(); }
  c.beginPath(); OUTLINE.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])))); c.closePath(); c.fillStyle = '#0f2638'; c.fill(); c.strokeStyle = '#2c4a63'; c.stroke();
  visibleQ().slice().reverse().forEach((q) => { const col = magColor(q.mag); c.beginPath(); c.arc(X(q.lon), Y(q.lat), 3.5 + q.mag * 2.3, 0, 6.283); c.fillStyle = col + '66'; c.fill(); c.strokeStyle = col; c.lineWidth = q.id === SEL ? 3 : 1.5; c.stroke(); });
  c.beginPath(); c.arc(X(user.lon), Y(user.lat), 5, 0, 6.283); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#4fc3f7'; c.lineWidth = 3; c.stroke();
}
function fbClick(e) {
  const cv = e.currentTarget, r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; if (!cv._t) return;
  let best = null, bd = 28; visibleQ().forEach((q) => { const d = Math.hypot(cv._t.X(q.lon) - x, cv._t.Y(q.lat) - y); if (d < bd) { bd = d; best = q; } }); if (best) selectEvent(best.id);
}

/* ---------- Barra de capas y controles del mapa ---------- */
function buildMapUI() {
  $('#mTop').innerHTML = '<div class="seg" id="segRange"><button data-r="1h">1 h</button><button data-r="24h">24 h</button><button data-r="7d">7 d</button></div>' +
    '<button class="chip" id="cMin"></button><button class="chip" id="cPan">Solo Panamá</button><button class="chip" id="cLinks">Réplicas</button><button class="chip" id="cWaves">Ondas P/S</button><button class="chip" id="cHeat">Calor</button><button class="chip" id="cBase"></button>';
  const ic = (d) => '<svg viewBox="0 0 24 24">' + d + '</svg>';
  $('#mSide').innerHTML = '<button class="ibtn" id="zIn" aria-label="Acercar">' + ic('<path d="M12 5v14M5 12h14"/>') + '</button><button class="ibtn" id="zOut" aria-label="Alejar">' + ic('<path d="M5 12h14"/>') + '</button>' +
    '<button class="ibtn" id="zPan" aria-label="Ver Panamá">' + ic('<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0"/>') + '</button><button class="ibtn" id="zMe" aria-label="Mi ubicación">' + ic('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>') + '</button>' +
    '<button class="ibtn" id="zRef" aria-label="Actualizar">' + ic('<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>') + '</button>';
  $('#mLegend').innerHTML = '<b class="cap" style="margin-right:2px">Magnitud</b>' + [[2, '<3'], [3, '3'], [4, '4'], [5, '5'], [6, '6+']].map((x) => '<span style="display:inline-flex;align-items:center;gap:4px"><i style="width:10px;height:10px;border-radius:50%;background:' + magColor(x[0] + 0.1) + ';display:inline-block"></i>' + x[1] + '</span>').join('') + '<span style="display:inline-flex;align-items:center;gap:4px;margin-left:6px"><i style="width:10px;height:10px;border-radius:50%;border:2px solid #4fc3f7;display:inline-block"></i>tú</span>';
  $$('#segRange button').forEach((b) => b.addEventListener('click', () => { cfg.range = b.dataset.r; saveCfg(); renderMapUI(); drawMap(); }));
  $('#cMin').addEventListener('click', () => { cfg.minMag = MINS[(MINS.indexOf(cfg.minMag) + 1) % MINS.length]; saveCfg(); renderMapUI(); drawMap(); });
  $('#cPan').addEventListener('click', () => { cfg.onlyPan = !cfg.onlyPan; saveCfg(); renderMapUI(); drawMap(); });
  $('#cLinks').addEventListener('click', () => { cfg.links = !cfg.links; saveCfg(); renderMapUI(); drawMap(); });
  $('#cWaves').addEventListener('click', () => { cfg.waves = !cfg.waves; saveCfg(); renderMapUI(); drawMap(); });
  $('#cHeat').addEventListener('click', () => { cfg.heat = !cfg.heat; saveCfg(); renderMapUI(); drawMap(); });
  $('#cBase').addEventListener('click', () => { const ks = Object.keys(TILES); cfg.map = ks[(ks.indexOf(cfg.map) + 1) % ks.length]; saveCfg(); setBase(cfg.map); renderMapUI(); });
  $('#zIn').addEventListener('click', () => map && map.zoomIn()); $('#zOut').addEventListener('click', () => map && map.zoomOut());
  $('#zPan').addEventListener('click', () => fitPanama()); $('#zMe').addEventListener('click', locateMe); $('#zRef').addEventListener('click', () => { poll(true); toast('Actualizando datos…', '', '', 1800); });
  renderMapUI();
}
function renderMapUI() {
  $$('#segRange button').forEach((b) => b.classList.toggle('on', b.dataset.r === cfg.range));
  $('#cMin').textContent = cfg.minMag ? '≥ M' + cfg.minMag.toFixed(1) : 'Toda magnitud'; $('#cMin').classList.toggle('on', cfg.minMag > 0);
  $('#cPan').classList.toggle('on', cfg.onlyPan); $('#cLinks').classList.toggle('on', cfg.links); $('#cWaves').classList.toggle('on', cfg.waves); $('#cHeat').classList.toggle('on', cfg.heat);
  $('#cBase').textContent = '🗺 ' + (TILES[cfg.map] || TILES.dark).name;
}

/* ---------- Selección y hoja de detalle ---------- */
function selectEvent(id, fly, keepAlarm) {
  const q = Q.find((x) => x.id === id); if (!q) return false;
  SEL = id; selQ = q; if (!keepAlarm && curTab !== 'radar') goTab('radar');
  openSheet(q); drawMap(); if (typeof renderEventos === 'function' && curTab === 'eventos') renderEventos();
  if (fly && map) map.flyTo([q.lat, q.lon], Math.max(map.getZoom(), 8.5), { duration: 0.8 });
  return true;
}
function closeSheet() { $('#sheet').classList.remove('on'); SEL = null; selQ = null; if (map) { gSel.clearLayers(); } }
function srcTags(q) { return (q.src || []).map((s) => '<span class="tag ' + (s === 'IGC' ? 'igc' : '') + '">' + esc(s) + (q.mags && q.mags[s] != null ? ' M' + (+q.mags[s]).toFixed(1) : '') + '</span>').join(' '); }
function openSheet(q) {
  const lvl = levelFor(q, user), d = km(user, q), hyp = Math.hypot(d, q.depth || 0), now = Date.now(), tS = q.t + hyp / VS * 1000, tP = q.t + hyp / VP * 1000;
  const links = Object.keys(q.links || {}).map((k) => '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(q.links[k]) + '">' + (k === 'IGC' ? 'Mapa IGC-UP' : k) + ' ↗</a>').join('');
  const main = q.main && Q.find((x) => x.id === q.main), age = (now - q.t) / 864e5;
  let fc = '';
  if (q.role === 'main' && q.mag >= 4 && age < 8) fc = '<dt>Réplicas</dt><dd>' + q.nrep + ' registradas' + (q.nfore ? ' · ' + q.nfore + ' posible(s) premonitor(es)' : '') + '<br><small class="note">≥M4 en 24 h: ' + Math.round(aftershockProb(q.mag, age, 4, 1) * 100) + ' % · ≥M5: ' + Math.round(aftershockProb(q.mag, age, 5, 1) * 100) + ' % (estimación genérica)</small></dd>';
  if (q.role === 'after' && main) fc = '<dt>Réplica de</dt><dd>M' + main.mag.toFixed(1) + ' · ' + esc(placeShort(main.place)) + ' · ' + ago(main.t) + '</dd>';
  if (q.role === 'fore' && main) fc = '<dt>Posible premonitor de</dt><dd>M' + main.mag.toFixed(1) + ' · ' + esc(placeShort(main.place)) + '</dd>';
  const sh = $('#sheet');
  sh.innerHTML = '<button class="ibtn x" id="shX" aria-label="Cerrar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
    '<div style="display:flex;gap:12px;align-items:center;padding-right:44px"><div class="mg" style="--c:' + magColor(q.mag) + ';min-width:68px;height:68px;font-size:26px">' + q.mag.toFixed(1) + '</div><div style="min-width:0"><div class="cap" style="color:' + LV_COLOR[lvl] + '">' + (lvl ? LV_NAME[lvl] : 'Sismo') + ' · ' + ROLE_TXT[q.role || 'single'] + '</div><b style="display:block;margin-top:2px">' + esc(q.place) + '</b></div></div>' +
    '<dl><dt>Hora local</dt><dd>' + when(q.t) + '<br><small class="note">' + ago(q.t) + '</small></dd>' +
    '<dt>UTC</dt><dd class="mono">' + new Date(q.t).toISOString().replace('T', ' ').slice(0, 19) + '</dd>' +
    '<dt>Profundidad</dt><dd>' + Math.round(q.depth || 0) + ' km · ' + depthClass(q.depth || 0) + '</dd>' +
    '<dt>Epicentro</dt><dd class="mono">' + q.lat.toFixed(3) + ', ' + q.lon.toFixed(3) + '</dd>' +
    '<dt>Distancia</dt><dd>' + Math.round(d) + ' km de ' + esc(userName()) + '<br><small class="note">' + (d < feltKm(q.mag) / 4 ? 'probablemente sentido fuerte' : d < feltKm(q.mag) ? 'probablemente sentido' : 'poco probable que se sienta') + ' (estimación)</small></dd>' +
    (now < tS + 30000 && now - q.t < 15 * 60e3 ? '<dt>Ondas en tu sitio</dt><dd>P ' + (tP > now ? 'en ' + Math.ceil((tP - now) / 1000) + ' s' : 'ya llegó') + ' · S ' + (tS > now ? 'en ' + Math.ceil((tS - now) / 1000) + ' s' : 'ya llegó') + '</dd>' : '') +
    '<dt>Estado</dt><dd>' + (q.st === 'R' ? '<span class="tag rev">revisado</span>' : '<span class="tag pre">preliminar</span>') + '</dd>' +
    '<dt>Fuentes</dt><dd>' + srcTags(q) + '</dd>' + fc +
    (q.tsunami ? '<dt>Tsunami</dt><dd style="color:#ff9fb0">Aviso asociado · consulta SINAPROC</dd>' : '') + (q.felt ? '<dt>Reportes sentido</dt><dd>' + q.felt + ' (USGS)</dd>' : '') + '</dl>' +
    '<div class="acts">' + links + '<button class="btn sm" id="shShare">Compartir</button><button class="btn sm" id="shCopy">Copiar</button>' + (q.role === 'main' || q.role === 'after' ? '<button class="btn sm" id="shRep">Ver réplicas</button>' : '') + '</div>';
  sh.classList.add('on');
  $('#shX').onclick = closeSheet;
  $('#shShare').onclick = () => { const t = 'Sismo M' + q.mag.toFixed(1) + ' · ' + placeShort(q.place) + ' · ' + when(q.t) + ' · prof. ' + Math.round(q.depth || 0) + ' km (' + (q.src || []).join('+') + ')'; if (navigator.share) navigator.share({ title: 'Sismo Panamá', text: t, url: location.origin + '/?q=' + encodeURIComponent(q.id) }).catch(() => { }); else { navigator.clipboard && navigator.clipboard.writeText(t); toast('Copiado', t, 'good'); } };
  $('#shCopy').onclick = () => { const t = 'M' + q.mag.toFixed(1) + ' | ' + q.place + ' | ' + new Date(q.t).toISOString() + ' | ' + q.lat.toFixed(4) + ',' + q.lon.toFixed(4) + ' | ' + Math.round(q.depth || 0) + ' km'; navigator.clipboard && navigator.clipboard.writeText(t); toast('Datos copiados', '', 'good', 1800); };
  const rp = $('#shRep'); if (rp) rp.onclick = () => { goTab('replicas'); };
}

/* ---------- Tarjeta principal (hero) ---------- */
function gaugeSVG(mag, col) {
  const L0 = Math.PI * 46, v = clamp(mag / 8, 0, 1) * L0;
  return '<svg class="gauge" viewBox="0 0 112 76"><path d="M10 64 A46 46 0 0 1 102 64" fill="none" stroke="rgba(120,190,230,.16)" stroke-width="9" stroke-linecap="round"/><path d="M10 64 A46 46 0 0 1 102 64" fill="none" stroke="' + col + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + v.toFixed(1) + ' ' + L0.toFixed(1) + '" style="filter:drop-shadow(0 0 6px ' + col + ')"/><text x="56" y="60" text-anchor="middle" fill="' + col + '" font-family="ui-monospace,Menlo,monospace" font-weight="800" font-size="26">' + (mag > 0 ? mag.toFixed(1) : '—') + '</text></svg>';
}
function panStats() {
  const now = Date.now(), pan = Q.filter((q) => inBox(q, PAN)), n24 = pan.filter((q) => now - q.t < 864e5).length, n7 = pan.filter((q) => now - q.t < 7 * 864e5).length;
  const mx = pan.filter((q) => now - q.t < 7 * 864e5).reduce((a, q) => Math.max(a, q.mag), 0);
  const avg = n7 / 7, ratio = n24 / Math.max(1, avg), act = ratio >= 3 ? 'ELEVADA' : ratio >= 1.6 ? 'ALTA' : 'NORMAL';
  return { n24, n7, mx, act, pan };
}
function renderHero() {
  const now = Date.now(), ps = panStats(); let best = null, bs = -1, bl = 0;
  for (const q of Q) { if (now - q.t > 2 * 3600e3) continue; const l = levelFor(q, user); if (!l) continue; const sc = l * 10 + q.mag; if (sc > bs) { bs = sc; best = q; bl = l; } }
  const h = $('#hero'); h.className = 'card' + (bl ? ' l' + bl : '');
  let top;
  if (best) {
    const col = magColor(best.mag), d = km(user, best);
    top = '<div class="top" data-id="' + esc(best.id) + '" style="cursor:pointer">' + gaugeSVG(best.mag, col) + '<div class="tt"><div class="lv" style="color:' + LV_COLOR[bl] + '">' + LV_NAME[bl] + ' · ' + ago(best.t) + '</div><div class="pl">' + esc(best.place) + '</div><small>a ' + Math.round(d) + ' km · prof. ' + Math.round(best.depth || 0) + ' km · ' + (best.st === 'R' ? 'revisado' : 'preliminar') + (best.role === 'after' ? ' · réplica' : best.role === 'main' && best.nrep ? ' · ' + best.nrep + ' réplicas' : '') + '</small></div></div>';
  } else {
    const last = ps.pan[0];
    top = '<div class="top"' + (last ? ' data-id="' + esc(last.id) + '" style="cursor:pointer"' : '') + '>' + gaugeSVG(last ? last.mag : 0, last ? magColor(last.mag) : '#27f0c4') + '<div class="tt"><div class="lv" style="color:var(--teal)">SIN ALERTAS ACTIVAS</div><div class="pl">' + (last ? 'Último en Panamá: ' + esc(placeShort(last.place)) : 'Sin sismos recientes en Panamá') + '</div><small>' + (last ? ago(last.t) + ' · prof. ' + Math.round(last.depth || 0) + ' km' : '') + '</small></div></div>';
  }
  h.innerHTML = top + '<div class="stats"><div><b>' + ps.n24 + '</b><span>Panamá 24 h</span></div><div><b>' + (ps.mx ? 'M' + ps.mx.toFixed(1) : '—') + '</b><span>Máx. 7 d</span></div><div><b style="font-size:13px;line-height:24px;color:' + (ps.act === 'NORMAL' ? 'var(--teal)' : ps.act === 'ALTA' ? 'var(--amber)' : 'var(--red)') + '">' + ps.act + '</b><span>Actividad</span></div></div>';
  const t = h.querySelector('.top[data-id]'); if (t) t.onclick = () => selectEvent(t.dataset.id, true);
}

/* ---------- Sismograma de 24 h ---------- */
function drawRibbon() {
  const cv = $('#rib'); if (!cv || !cv.clientWidth) return;
  const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1; if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const mid = h / 2 + 4, span = 864e5, now = Date.now(), X = (t) => w - 8 - ((now - t) / span) * (w - 16);
  c.strokeStyle = 'rgba(120,190,230,.10)'; c.lineWidth = 1; c.fillStyle = 'rgba(134,160,179,.55)'; c.font = '9px ui-monospace,monospace';
  for (let i = 0; i <= 8; i++) { const t = now - i * 3 * 3600e3, x = X(t); c.beginPath(); c.moveTo(x, 14); c.lineTo(x, h); c.stroke(); if (i && i < 8) c.fillText(fClock.format(t).slice(0, 5), x + 3, h - 4); }
  c.strokeStyle = 'rgba(39,240,196,.35)'; c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid); c.stroke();
  Q.filter((q) => now - q.t < span && (inBox(q, PAN) || q.mag >= 4.5)).slice().reverse().forEach((q) => {
    const x = X(q.t), col = magColor(q.mag), A = Math.min(h / 2 - 6, 3 + Math.pow(q.mag, 1.75) * 0.95), N = 16 + Math.round(q.mag * 3);
    c.beginPath(); c.strokeStyle = col; c.lineWidth = q.id === SEL ? 2.4 : 1.4; c.globalAlpha = inBox(q, PAN) ? 1 : 0.55;
    for (let i = 0; i <= N; i++) { const y = mid + Math.sin(i * 1.7) * A * Math.exp(-i / (N / 2.8)) * (i === 0 ? 0.2 : 1); i ? c.lineTo(x + i * 0.9, y) : c.moveTo(x, y); }
    c.stroke(); c.globalAlpha = 1;
  });
  const g = c.createLinearGradient(w - 36, 0, w, 0); g.addColorStop(0, 'rgba(39,240,196,0)'); g.addColorStop(1, 'rgba(39,240,196,.22)'); c.fillStyle = g; c.fillRect(w - 36, 0, 36, h);
  c.fillStyle = '#27f0c4'; c.beginPath(); c.arc(w - 8, mid, 3.2, 0, 6.283); c.fill();
}
function ribClick(e) {
  const cv = $('#rib'), r = cv.getBoundingClientRect(), x = e.clientX - r.left, w = r.width, now = Date.now(); let best = null, bd = 16;
  Q.forEach((q) => { if (now - q.t > 864e5 || !(inBox(q, PAN) || q.mag >= 4.5)) return; const qx = w - 8 - ((now - q.t) / 864e5) * (w - 16), d = Math.abs(qx + 8 - x); if (d < bd) { bd = d; best = q; } });
  if (best) selectEvent(best.id, true);
}
