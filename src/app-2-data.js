/* ======================================================================
   Parte 2 · datos en vivo, motor de alertas, alarma, sensor, notificaciones, push
   ====================================================================== */
let serverQ = LS.get('quakes', []), wsQ = [], Q = [], SRC = {}, apiOk = false, wsOn = false, apiAt = LS.get('apiAt', 0), lastErr = '', active = false, SEL = null, firstPoll = true;

function rebuild() {
  const now = Date.now();
  wsQ = wsQ.filter((w) => now - w.t < 3600e3);
  const extra = wsQ.filter((w) => !serverQ.some((s) => sameEvent(s, w)));
  Q = serverQ.concat(extra).sort((a, b) => b.t - a.t);
  annotate(Q);
  evaluate();
  renderAll();
}
async function poll(manual) {
  if (!navigator.onLine) { setOnline(false); return; }
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch('/api/quakes?days=8' + (manual ? '&fresh=1' : ''), { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    serverQ = j.quakes || []; SRC = j.sources || {}; apiAt = Date.now(); apiOk = true; lastErr = '';
    LS.set('apiAt', apiAt); LS.set('quakes', serverQ.slice(0, 450));
    setOnline(true); rebuild();
    if (firstPoll) { firstPoll = false; missedSummary(); }
  } catch (e) {
    clearTimeout(to); apiOk = false; lastErr = String(e && e.message || e); renderLeds();
  }
}
const pollSoon = debounce(() => poll(true), 4000);

/* EMSC en vivo por WebSocket (avisa antes de que otras redes publiquen) */
let ws = null, wsTry = 0;
function connectWS() {
  try { ws = new WebSocket('wss://www.seismicportal.eu/standing_order/websocket'); } catch (e) { return; }
  ws.onopen = () => { wsOn = true; wsTry = 0; renderLeds(); };
  ws.onmessage = (m) => {
    try {
      const j = JSON.parse(m.data), p = j.data && j.data.properties; if (!p) return;
      const e = { id: 'W' + (p.unid || j.data.id), t: Date.parse(p.time), lat: +p.lat, lon: +p.lon, depth: Math.abs(+p.depth || 0), mag: +p.mag, place: p.flynn_region || 'Sin nombre', st: 'P', src: ['EMSC'], mags: { EMSC: +p.mag }, links: p.unid ? { EMSC: 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=' + p.unid } : {} };
      if (!isFinite(e.mag) || !isFinite(e.t) || !isFinite(e.lat) || !inBox(e, REG) || (p.evtype && p.evtype !== 'ke')) return;
      const i = wsQ.findIndex((x) => x.id === e.id); if (i >= 0) wsQ[i] = e; else wsQ.push(e);
      rebuild(); pollSoon();
    } catch (err) { }
  };
  ws.onclose = () => { wsOn = false; renderLeds(); setTimeout(connectWS, Math.min(30000, 2000 * (++wsTry))); };
  ws.onerror = () => { try { ws.close(); } catch (e) { } };
}
function setOnline(v) { $('#offline').style.display = v ? 'none' : 'block'; }

/* ---------- Motor de alertas ---------- */
let seen = LS.get('seen', []);
const findSeen = (q) => seen.find((s) => sameEvent(s, q));
function evaluate() {
  const now = Date.now(); seen = seen.filter((s) => now - s.t < 12 * 3600e3);
  const first = !LS.get('seenInit', false); let changed = false;
  for (const q of Q) {
    const age = now - q.t; if (age > 45 * 60e3) continue;
    const lvl = levelFor(q, user); if (!lvl) continue;
    const thr = inBox(q, PAN) ? cfg.m1 : cfg.m2, isRep = q.role === 'after' && q.mag < 4.5 && lvl < 3;
    if (!(lvl >= 2 || q.mag >= thr)) continue;
    if (isRep && !cfg.replicas && lvl < 2) { if (!findSeen(q)) { seen.push({ t: q.t, lat: q.lat, lon: q.lon, mag: q.mag, lvl }); changed = true; } continue; }
    const prev = findSeen(q);
    if (!prev) { seen.push({ t: q.t, lat: q.lat, lon: q.lon, mag: q.mag, lvl }); changed = true; if (first && age > 10 * 60e3) continue; trigger(q, lvl, isRep, 'new'); }
    else if (q.mag >= prev.mag + 0.4 || lvl > prev.lvl) { prev.mag = q.mag; prev.lvl = Math.max(prev.lvl, lvl); changed = true; trigger(q, lvl, isRep, 'upd'); }
  }
  if (first && Q.length) LS.set('seenInit', true);
  if (changed) LS.set('seen', seen);
  badge();
}
function trigger(q, lvl, isRep, kind) {
  if (!active) { osNotify(q, lvl, isRep, kind); return; }
  const full = !isRep && lvl >= cfg.full;
  if (full) showAlarm(q, lvl, kind);
  else {
    Snd.play(isRep ? 'replica' : lvl >= 2 ? 'alert' : 'info'); vib(isRep ? [150, 80, 150] : [250, 100, 250]);
    toast((isRep ? '↺ Réplica ' : kind === 'upd' ? 'Actualizado · ' : 'Sismo ') + 'M' + q.mag.toFixed(1) + ' · ' + placeShort(q.place), ago(q.t) + ' · a ' + Math.round(km(user, q)) + ' km · prof. ' + Math.round(q.depth) + ' km', lvl >= 2 ? 'warn' : '', 7000, () => { selectEvent(q.id, true); });
  }
  if (document.hidden || !document.hasFocus()) osNotify(q, lvl, isRep, kind);
}
function badge() {
  try {
    const n = Q.filter((q) => inBox(q, PAN) && q.mag >= 3.5 && Date.now() - q.t < 6 * 3600e3).length;
    if (navigator.setAppBadge) { if (n) navigator.setAppBadge(n); else navigator.clearAppBadge(); }
    const b = $('#nav [data-tab=eventos] .dot'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
  } catch (e) { }
}
function missedSummary() {
  const last = LS.get('lastOpen', 0), now = Date.now(); LS.set('lastOpen', now);
  if (!last || now - last < 20 * 60e3) return;
  const m = Q.filter((q) => q.t > last && inBox(q, PAN) && q.mag >= cfg.m1);
  if (!m.length) return;
  const top = m.reduce((a, q) => (q.mag > a.mag ? q : a), m[0]);
  toast('Mientras estabas fuera: ' + m.length + (m.length === 1 ? ' sismo' : ' sismos') + ' ≥ M' + cfg.m1.toFixed(1), 'El mayor: M' + top.mag.toFixed(1) + ' · ' + placeShort(top.place) + ' · ' + ago(top.t), 'warn', 9000, () => selectEvent(top.id, true));
}

/* ---------- Alarma a pantalla completa ---------- */
const AL = { on: false, q: null, lvl: 0, timers: [], phase: 'wave', lastTick: 0, sDone: false, late: false };
function showAlarm(q, lvl, kind) {
  if (AL.on && AL.q && sameEvent(AL.q, q) && lvl <= AL.lvl && kind !== 'upd') return;
  closeAlarm(true);
  Object.assign(AL, { on: true, q, lvl, phase: 'wave', sDone: false, lastTick: 0 });
  const d = km(user, q), hyp = Math.hypot(d, q.depth || 0), age = Date.now() - q.t;
  AL.tP = q.t + hyp / VP * 1000; AL.tS = q.t + hyp / VS * 1000; AL.local = !!q.local; AL.late = !q.local && age > 5 * 60e3;
  const el = $('#alarm'); el.className = 'on l' + lvl;
  const title = q.local ? 'MOVIMIENTO DETECTADO' : lvl === 3 ? 'PELIGRO · SISMO FUERTE' : lvl === 2 ? 'ALERTA SÍSMICA' : 'AVISO SÍSMICO';
  el.innerHTML = '<div class="lvl">' + title + (kind === 'upd' ? ' · ACTUALIZADO' : '') + (AL.late ? ' · HACE ' + Math.round(age / 60000) + ' MIN' : '') + '</div>' +
    '<div class="big">' + (q.local ? '!' : 'M' + q.mag.toFixed(1)) + '</div>' +
    '<div class="pl">' + esc(q.local ? 'El acelerómetro detectó una sacudida con el equipo quieto' : q.place) + '</div>' +
    '<div class="sub">' + (q.local ? 'Si sentiste el temblor, protégete. Consulta las redes oficiales para confirmar.' : 'a ' + Math.round(d) + ' km de ' + esc(userName()) + ' · prof. ' + Math.round(q.depth || 0) + ' km · ' + (q.st === 'R' ? 'revisado' : 'preliminar') + ' · ' + esc((q.src || []).join(' + '))) + '</div>' +
    '<div class="eta" id="aEta"></div>' +
    '<div class="tips" id="aTips"></div>' +
    '<div class="acts"><button class="ok" id="aOk">ENTENDIDO</button><button id="aSafe">ESTOY BIEN</button><button id="aMap">VER MAPA</button><button id="aMute">SILENCIAR</button></div>';
  $('#aOk').onclick = () => closeAlarm(); $('#aMute').onclick = () => { Snd.stopSiren(); try { speechSynthesis.cancel(); } catch (e) { } AL.timers.forEach(clearInterval); AL.timers = [setInterval(tickAlarm, 250)]; };
  $('#aMap').onclick = () => { closeAlarm(); selectEvent(q.id, true); }; $('#aSafe').onclick = () => estoyBien(q);
  if (q.local) { Snd.play('local'); vib([300, 100, 300, 100, 300]); speak('Movimiento detectado. Agáchate, cúbrete y sujétate.'); }
  else if (AL.late) { Snd.play('alert'); vib([300, 120, 300]); setPhase('post'); }
  else if (lvl >= 3) { Snd.startSiren(); AL.timers.push(setInterval(() => vib([500, 150, 500, 150, 900]), 2400)); vib([500, 150, 500, 150, 900]); speak('Peligro. Sismo fuerte de magnitud ' + q.mag.toFixed(1) + '. Agáchate, cúbrete y sujétate.'); }
  else { Snd.play('alert'); AL.timers.push(setInterval(() => Snd.play('alert'), 9000)); vib([400, 120, 400, 120, 600]); speak('Alerta. Sismo de magnitud ' + q.mag.toFixed(1) + ' cerca de ' + placeShort(q.place) + '. Agáchate, cúbrete y sujétate.'); }
  AL.timers.push(setInterval(tickAlarm, 250)); tickAlarm();
  if (!q.local) { goTab('radar'); setTimeout(() => selectEvent(q.id, true, true), 50); }
}
function setPhase(ph) {
  AL.phase = ph; const el = $('#alarm'); if (!el) return;
  if (ph === 'post') {
    el.className = 'on post'; Snd.stopSiren(); AL.timers.forEach(clearInterval); AL.timers = [setInterval(tickAlarm, 500)];
    const q = AL.q, coast = q && !q.local && q.mag >= 6;
    $('#aTips').innerHTML = (AL.late ? 'Este sismo ya ocurrió. ' : 'Ya pasó la llegada estimada de la onda S. ') + 'Revisa si hay heridos, aléjate de ventanas y estructuras dañadas y <b>espera posibles réplicas</b>.' + (coast ? '<br>Si estás en la costa y el sismo fue fuerte o prolongado, <b>ve a terreno alto sin esperar avisos</b>.' : '') + '<br><small style="font-weight:500;opacity:.85">Fuentes oficiales: IGC-UP y SINAPROC · Emergencias 911</small>';
  }
}
function tickAlarm() {
  if (!AL.on) return;
  const now = Date.now(), tips = $('#aTips'), eta = $('#aEta'); if (!tips) return;
  if (AL.phase === 'wave') {
    tips.innerHTML = 'AGÁCHATE · CÚBRETE · SUJÉTATE<br><small style="font-weight:500">Aléjate de ventanas y objetos que caen. No uses ascensores. No salgas corriendo durante el movimiento.</small>';
    if (AL.local) { eta.innerHTML = ''; if (now - AL.t0 > 45000) setPhase('post'); return; }
    const rp = (AL.tP - now) / 1000, rs = (AL.tS - now) / 1000;
    eta.innerHTML = '<div><b>' + (rp > 0 ? Math.ceil(rp) + ' s' : 'llegó') + '</b><span>Onda P</span></div><div><b>' + (rs > 0 ? Math.ceil(rs) + ' s' : 'llegó') + '</b><span>Onda S · fuerte</span></div>';
    if (rs > 0 && rs <= 15) { const sec = Math.ceil(rs); if (sec !== AL.lastTick) { AL.lastTick = sec; Snd.play(sec <= 5 ? 'tickU' : 'tick'); } }
    if (rs <= 0 && !AL.sDone) { AL.sDone = true; Snd.play('swave'); vib([800, 150, 800]); }
    if (rs < -25) setPhase('post');
  } else eta.innerHTML = '<div><b>' + Math.round((now - AL.q.t) / 60000) + ' min</b><span>desde el sismo</span></div>';
}
function closeAlarm(silent) {
  AL.timers.forEach(clearInterval); AL.timers = []; Snd.stopSiren(); try { speechSynthesis.cancel(); } catch (e) { }
  const was = AL.on; AL.on = false; const el = $('#alarm'); if (el) { el.className = ''; el.innerHTML = ''; }
  if (was && !silent && AL.phase === 'post') Snd.play('clear');
}
function estoyBien(q) {
  const msg = 'Estoy bien tras el sismo' + (q && !q.local ? ' M' + q.mag.toFixed(1) + ' (' + placeShort(q.place) + ')' : '') + '. Mi ubicación: https://maps.google.com/?q=' + user.lat.toFixed(5) + ',' + user.lon.toFixed(5);
  if (navigator.share) navigator.share({ text: msg }).catch(() => { });
  else { const c = LS.get('contacts', []), to = c.length ? c[0].tel : ''; location.href = 'sms:' + to + '?&body=' + encodeURIComponent(msg); }
}
function drill() {
  const q = { id: 'DRILL' + Date.now(), src: ['SIMULACRO'], t: Date.now() - 2000, lat: user.lat - 0.45, lon: user.lon - 0.35, depth: 14, mag: 6.2, place: 'SIMULACRO · Zona de Fractura de Panamá', st: 'P', mags: {}, links: {}, role: 'single' };
  q.lat = clamp(q.lat, 5, 10); const d = km(user, q); q.t = Math.min(Date.now() + 12000 - Math.hypot(d, 14) / VS * 1000, Date.now() - 1500);
  serverQ.unshift(q); seen.push({ t: q.t, lat: q.lat, lon: q.lon, mag: q.mag, lvl: 3 }); rebuild(); showAlarm(q, 3);
  osNotify(q, 3, false, 'new', true);
}

/* ---------- Acelerómetro: detector local STA/LTA ---------- */
const SN = { perm: false, t: 0, sta: 0, lta: 0, gx: 0, gy: 0, gz: 0, trig: 0, cool: 0, still: 0, armed: false, trace: new Float32Array(160), ti: 0, last: 0 };
const SENS = [null, 0.2, 0.12, 0.07];
function onMotion(e) {
  if (!cfg.sensor) return;
  const now = performance.now(), dt = SN.t ? (now - SN.t) / 1000 : 0.02; SN.t = now; SN.last = Date.now(); if (dt <= 0 || dt > 1) return;
  const a = e.acceleration; let x, y, z;
  if (a && a.x != null) { x = a.x; y = a.y; z = a.z; }
  else { const g = e.accelerationIncludingGravity; if (!g || g.x == null) return; SN.gx += 0.1 * (g.x - SN.gx); SN.gy += 0.1 * (g.y - SN.gy); SN.gz += 0.1 * (g.z - SN.gz); x = g.x - SN.gx; y = g.y - SN.gy; z = g.z - SN.gz; }
  const m = Math.sqrt(x * x + y * y + z * z), as = 1 - Math.exp(-dt / 0.5), al = 1 - Math.exp(-dt / 10);
  SN.sta += as * (m - SN.sta); SN.lta += al * (m - SN.lta);
  SN.still = SN.lta < 0.05 ? Math.min(SN.still + dt, 60) : 0; SN.armed = SN.still >= 8;
  SN.trace[SN.ti++ % SN.trace.length] = m;
  const thr = SENS[cfg.sens] || 0.12;
  if (SN.armed && SN.sta > thr && SN.sta / (SN.lta + 0.02) > 4) SN.trig += dt; else SN.trig = Math.max(0, SN.trig - dt);
  if (SN.trig > 1.2 && now > SN.cool) {
    SN.cool = now + 90000; SN.trig = 0;
    const lq = { id: 'LOCAL' + Date.now(), src: ['SENSOR'], t: Date.now(), lat: user.lat, lon: user.lon, depth: 0, mag: 0, place: 'Sensor local', local: true, mags: {}, links: {} };
    const log = LS.get('localLog', []); log.unshift({ t: lq.t, peak: +SN.sta.toFixed(3) }); LS.set('localLog', log.slice(0, 30));
    osNotify(lq, 2, false, 'new'); showAlarm(lq, 2);
  }
}
async function sensorStart(ask) {
  if (typeof DeviceMotionEvent === 'undefined') { SN.perm = false; return false; }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    if (!ask) return SN.perm;
    try { SN.perm = (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch (e) { SN.perm = false; }
  } else SN.perm = true;
  window.removeEventListener('devicemotion', onMotion);
  if (cfg.sensor && SN.perm) window.addEventListener('devicemotion', onMotion);
  return SN.perm;
}
function sensorState() {
  if (typeof DeviceMotionEvent === 'undefined') return ['bad', 'Este dispositivo no tiene acelerómetro web'];
  if (!cfg.sensor) return ['', 'Desactivado'];
  if (!SN.perm) return ['warn', 'Falta permiso del sensor (toca "Activar sensor")'];
  if (Date.now() - SN.last > 4000) return ['warn', 'Sin datos del sensor (en computadoras de escritorio no hay acelerómetro)'];
  return SN.armed ? ['ok', 'Armado · equipo quieto · sacudida ' + SN.sta.toFixed(3) + ' m/s²'] : ['warn', 'Esperando quietud (' + Math.round(SN.still) + '/8 s) · apoya el equipo'];
}

/* ---------- Notificaciones del sistema ---------- */
async function ensureNotifPerm() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { } }
  return Notification.permission;
}
async function notify(title, body, tag, o) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = Object.assign({ body, tag, icon: '/icon-192.png', badge: '/icon-192.png', lang: 'es', renotify: true, timestamp: Date.now(), vibrate: [300, 100, 300, 100, 600], requireInteraction: true }, o || {});
  try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(title, opts); }
  catch (e) { try { new Notification(title, { body, tag, icon: '/icon-192.png' }); } catch (_) { } }
}
function osNotify(q, lvl, isRep, kind, force) {
  if (Notification.permission !== 'granted' && !force) return;
  const d = Math.round(km(user, q)), head = kind === 'upd' ? 'ACTUALIZADO · ' : '';
  const title = q.local ? 'Movimiento local detectado' : isRep ? head + '↺ Réplica M' + q.mag.toFixed(1) : lvl === 3 ? head + '🔴 SISMO FUERTE · M' + q.mag.toFixed(1) : lvl === 2 ? head + '🟠 ALERTA · M' + q.mag.toFixed(1) : head + '🔵 Sismo M' + q.mag.toFixed(1);
  notify(title, q.local ? 'Verifica si fue un sismo en las fuentes oficiales.' : q.place + ' · prof. ' + Math.round(q.depth || 0) + ' km · a ' + d + ' km de ti · ' + ago(q.t) + (q.tsunami ? ' · posible tsunami: consulta SINAPROC' : ''), 'q-' + q.id,
    { requireInteraction: lvl >= 2, vibrate: lvl >= 3 ? [600, 150, 600, 150, 900] : [300, 100, 300], data: { id: q.id, url: '/?q=' + encodeURIComponent(q.id), lvl }, actions: [{ action: 'map', title: 'Ver en el mapa' }, { action: 'close', title: 'Cerrar' }] });
}
function persistNote() {
  if (!cfg.persist || !active || !('Notification' in window) || Notification.permission !== 'granted') return;
  const n24 = Q.filter((q) => inBox(q, PAN) && Date.now() - q.t < 864e5).length, last = Q.find((q) => inBox(q, PAN));
  notify('Vigilancia sísmica activa', 'Panamá: ' + n24 + ' sismos en 24 h' + (last ? ' · último M' + last.mag.toFixed(1) + ' ' + ago(last.t) : '') + ' · revisado ' + fClock.format(Date.now()).slice(0, 5), 'monitor',
    { silent: true, renotify: false, requireInteraction: true, vibrate: [], data: { url: '/' }, actions: [{ action: 'open', title: 'Abrir' }] });
}
async function clearPersist() { try { const reg = await navigator.serviceWorker.ready; (await reg.getNotifications({ tag: 'monitor' })).forEach((n) => n.close()); } catch (e) { } }

/* ---------- Web Push (alertas con la app cerrada) ---------- */
let pushInfo = { supported: null, kv: null, sub: false };
function b64uToU8(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushPrefs = () => ({ m1: cfg.m1, m2: cfg.m2, la: user.lat, lo: user.lon, r: cfg.replicas ? 1 : 0 });
async function pushCheck() {
  if (!pushSupported()) { pushInfo = { supported: false }; return pushInfo; }
  try {
    const k = await (await fetch('/api/push/key', { cache: 'no-store' })).json(), reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    pushInfo = { supported: true, kv: !!k.ok, sub: !!sub, perm: Notification.permission };
  } catch (e) { pushInfo = { supported: true, kv: null, sub: false, err: String(e) }; }
  return pushInfo;
}
async function pushEnable() {
  if (!pushSupported()) { toast('Este navegador no soporta Push', 'En iPhone: instala la app (Compartir → Añadir a pantalla de inicio) e iOS 16.4+', 'warn', 8000); return false; }
  const perm = await ensureNotifPerm(); if (perm !== 'granted') { toast('Permiso de notificaciones denegado', 'Actívalo en los ajustes del navegador para este sitio', 'bad', 7000); return false; }
  const k = await (await fetch('/api/push/key', { cache: 'no-store' })).json();
  if (!k.ok) { toast('El servidor aún no tiene Push', 'Enlaza un KV llamado SISMO_KV y un Cron (ver /api)', 'warn', 9000); return false; }
  try {
    const reg = await navigator.serviceWorker.ready; let sub = await reg.pushManager.getSubscription();
    if (sub) { const cur = sub.options && sub.options.applicationServerKey; if (cur && b64uToU8(k.key).length === cur.byteLength && Array.from(new Uint8Array(cur)).join() !== Array.from(b64uToU8(k.key)).join()) { await sub.unsubscribe(); sub = null; } }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(k.key) });
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: sub.toJSON(), prefs: pushPrefs() }) });
    const j = await r.json(); if (!j.ok) throw new Error(j.reason || 'error');
    cfg.push = true; LS.set('cfg', cfg); await pushCheck(); toast('Alertas push activadas', 'Recibirás avisos aunque la app esté cerrada', 'good'); return true;
  } catch (e) { toast('No se pudo activar el push', String(e && e.message || e), 'bad', 8000); return false; }
}
async function pushDisable() {
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) { await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); } } catch (e) { }
  cfg.push = false; LS.set('cfg', cfg); await pushCheck(); toast('Alertas push desactivadas', '', '');
}
const pushSync = debounce(async () => {
  if (!cfg.push || !pushSupported()) return;
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (!sub) return; await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: sub.toJSON(), prefs: pushPrefs() }) }); } catch (e) { }
}, 1500);
async function pushTest() {
  try {
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (!sub) { toast('Primero activa las alertas push', '', 'warn'); return; }
    const r = await (await fetch('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: sub.toJSON() }) })).json();
    toast(r.ok ? 'Push de prueba enviado' : 'El push falló', r.ok ? 'Debería llegar en unos segundos' : (r.reason || 'código ' + r.status), r.ok ? 'good' : 'bad', 6000);
  } catch (e) { toast('El push falló', String(e), 'bad'); }
}

/* ---------- Pantalla: wake lock, pantalla completa, instalación ---------- */
let wl = null;
async function wakeLock() { if (!cfg.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return; try { if (wl && !wl.released) return; wl = await navigator.wakeLock.request('screen'); } catch (e) { } }
function goFs() { const el = document.documentElement; try { const f = el.requestFullscreen || el.webkitRequestFullscreen; if (f) f.call(el, { navigationUI: 'hide' }); } catch (e) { } }
function toggleFs() { if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } else goFs(); }
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (typeof renderAjustes === 'function' && curTab === 'ajustes') renderAjustes(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; toast('App instalada', 'Ábrela desde tu pantalla de inicio', 'good'); });
async function doInstall() {
  if (deferredInstall) { deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) { } deferredInstall = null; }
  else toast('Instalar la app', isIOS ? 'Toca Compartir → "Añadir a pantalla de inicio"' : 'Menú del navegador → "Instalar aplicación" / "Añadir a pantalla de inicio"', '', 9000);
}
function applyDisplay() {
  document.body.classList.toggle('kiosk', !!cfg.kiosk); document.body.classList.toggle('dim', !!cfg.dim);
  const m = $('#bMute'); if (m) m.classList.toggle('off', !cfg.sound);
  if (typeof map !== 'undefined' && map) setTimeout(() => map.invalidateSize(), 120);
}
