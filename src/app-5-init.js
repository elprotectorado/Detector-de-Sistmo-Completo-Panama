/* ======================================================================
   Parte 5 · navegación, arranque, service worker, eventos globales
   ====================================================================== */
const NAV_ICONS = {
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/><path d="M12 12l6-5"/>',
  eventos: '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="1.4"/>',
  replicas: '<path d="M3 12h3l2-6 3 12 3-9 2 3h5"/>',
  datos: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  guia: '<path d="M12 3l8 3v6c0 4.5-3.4 7.6-8 9-4.6-1.4-8-4.5-8-9V6l8-3z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'
};
function buildNav() {
  $('#nav').innerHTML = '<img class="brand" src="/icon-192.png" alt="">' + TABS.map((t) => '<button data-tab="' + t + '" aria-label="' + TAB_NAME[t] + '"><svg viewBox="0 0 24 24">' + NAV_ICONS[t] + '</svg>' + TAB_NAME[t] + (t === 'eventos' ? '<span class="dot" style="display:none"></span>' : '') + '</button>').join('');
  $$('#nav button').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.tab)));
}
function goTab(t) {
  if (!TABS.includes(t)) t = 'radar';
  curTab = t; LS.set('tab', t);
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + t));
  try {
    if (t === 'radar') { setTimeout(() => { if (map) map.invalidateSize(); drawMap(); drawRibbon(); }, 60); }
    else if (t === 'eventos') renderEventos(); else if (t === 'replicas') renderReplicas(); else if (t === 'datos') renderDatos();
    else if (t === 'guia') renderGuia(); else if (t === 'ajustes') renderAjustes();
  } catch (e) { console.error(e); }
  const v = $('#v-' + t); if (v && t !== 'radar') v.scrollTop = 0;
}
function openFromUrl(u) {
  try {
    const x = new URL(u, location.origin), id = x.searchParams.get('q'), tab = x.searchParams.get('tab');
    if (id) { if (!selectEvent(id, true)) { poll(true).then(() => selectEvent(id, true)); } } else if (tab) goTab(tab);
  } catch (e) { }
}

/* ---------- Puerta de entrada (gesto del usuario) ---------- */
async function enter(full) {
  if (active) return; active = true;
  const g = $('#gate'); g.style.opacity = '0'; setTimeout(() => { g.style.display = 'none'; }, 350);
  LS.set('gateDone', true);
  if (full) {
    goFs(); Snd.init(); Snd.play('info'); vib(60);
    wakeLock();
    ensureNotifPerm().then(() => persistNote());
    sensorStart(true).then(() => { if (curTab === 'ajustes') liveAjustes(); });
    if (cfg.gps && !LS.get('gpsAsked', false)) { LS.set('gpsAsked', true); gpsFix().then((ok) => { if (ok) { cfg.city = 'gps'; saveCfg(); renderAll(); toast('Ubicación detectada', 'Distancias y alertas calculadas desde tu posición', 'good'); } }); }
  } else { sensorStart(false); }
  applyDisplay(); map && map.invalidateSize();
  speak.warm && speak.warm();
}

/* ---------- Service worker ---------- */
async function initSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'push') { pollSoon(); if (m.data && m.data.id && document.visibilityState === 'visible') setTimeout(() => selectEvent(m.data.id, true), 1500); }
      else if (m.type === 'open') openFromUrl(m.url || '/');
      else if (m.type === 'resub') { if (cfg.push) pushEnable(); }
    });
    if ('periodicSync' in reg) {
      try { const st = await navigator.permissions.query({ name: 'periodic-background-sync' }); if (st.state === 'granted') await reg.periodicSync.register('quake-check', { minInterval: 15 * 60 * 1000 }); } catch (e) { }
    }
    reg.addEventListener('updatefound', () => { const nw = reg.installing; if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Nueva versión lista', 'Toca para actualizar', 'good', 12000, () => location.reload()); }); });
  } catch (e) { console.warn('SW', e); }
}

/* ---------- Arranque ---------- */
function boot() {
  buildNav(); applyDisplay(); initMap();
  $('#go').addEventListener('click', () => enter(true));
  $('#skip').addEventListener('click', () => enter(false));
  $('#bFs').addEventListener('click', toggleFs);
  $('#bMute').addEventListener('click', () => { cfg.sound = !cfg.sound; saveCfg(); applyDisplay(); if (cfg.sound) { Snd.init(); Snd.play('info'); } toast(cfg.sound ? 'Sonido activado' : 'Sonido silenciado', '', '', 1600); if (curTab === 'ajustes') renderAjustes(); });
  $('#rib').addEventListener('click', ribClick);
  $('#dim').addEventListener('dblclick', () => { cfg.dim = false; saveCfg(); applyDisplay(); });
  goTab('radar');
  const p = new URL(location.href).searchParams, qid = p.get('q'), tab = p.get('tab');
  if (tab) goTab(tab);
  renderAll();
  if (qid) setTimeout(() => openFromUrl(location.href), 500);
  poll(); connectWS(); initSW(); pushCheck();
  setInterval(() => poll(), 12000);
  setInterval(() => { persistNote(); renderLeds(); }, 60000);
  setInterval(() => {
    $('#clk').textContent = fClock.format(Date.now());
    try { tickWaves(); if (curTab === 'radar') renderHero(); if (curTab === 'ajustes') liveAjustes(); } catch (e) { }
  }, 1000);
  setInterval(() => { try { drawRibbon(); if (!map) drawFallback(); } catch (e) { } }, 30000);
  $('#clk').textContent = fClock.format(Date.now());
  window.addEventListener('online', () => { setOnline(true); poll(true); connectWS(); });
  window.addEventListener('offline', () => { setOnline(false); renderLeds(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wakeLock(); poll(true); renderLeds(); } else LS.set('lastOpen', Date.now()); });
  window.addEventListener('pagehide', () => LS.set('lastOpen', Date.now()));
  window.addEventListener('resize', debounce(() => { if (map) map.invalidateSize(); drawRibbon(); renderLeds(); if (!map) drawFallback(); if (['datos', 'replicas'].includes(curTab)) renderAll(); }, 200));
  document.addEventListener('fullscreenchange', () => { setTimeout(() => { if (map) map.invalidateSize(); }, 200); });
  document.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test((e.target.tagName || ''))) return;
    if (e.key === 'Escape') { if (AL.on) closeAlarm(); else closeSheet(); }
    else if (e.key >= '1' && e.key <= '6') goTab(TABS[+e.key - 1]);
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 'm' || e.key === 'M') $('#bMute').click();
    else if (e.key === 'r' || e.key === 'R') poll(true);
  });
  if (isStandalone() && LS.get('gateDone', false)) { $('#go').textContent = 'ENTRAR'; }
  document.addEventListener('click', () => { if (active) Snd.init(); }, { once: false, passive: true });
  /* Primer sondeo con datos guardados mientras llega la red */
  if (serverQ.length) rebuild();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
