'use strict';
/* ======================================================================
   ISTMO · Sismo Panamá — By @elprotectorado
   Parte 1 · utilidades, configuración, motor de sonido y voz
   ====================================================================== */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const km = kmDist;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('istmo.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('istmo.' + k, JSON.stringify(v)); } catch (e) { } },
  del(k) { try { localStorage.removeItem('istmo.' + k); } catch (e) { } }
};
const TZ = 'America/Panama';
const fTime = new Intl.DateTimeFormat('es-PA', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
const fDate = new Intl.DateTimeFormat('es-PA', { timeZone: TZ, day: '2-digit', month: 'short' });
const fClock = new Intl.DateTimeFormat('es-PA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const when = (t) => fDate.format(t) + ' · ' + fTime.format(t);
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'hace ' + Math.round(s) + ' s';
  if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return 'hace ' + h + ' h' + (m ? ' ' + m + ' min' : ''); }
  return 'hace ' + Math.round(s / 86400) + ' d';
}
function magColor(m) { return m < 2.5 ? '#5f7a8f' : m < 3.5 ? '#27f0c4' : m < 4.5 ? '#ffd166' : m < 5.5 ? '#ff9f43' : m < 6.5 ? '#ff4d6d' : '#ff2bd6'; }
const LV_NAME = ['', 'INFORMATIVO', 'ALERTA', 'PELIGRO'];
const LV_COLOR = ['#27f0c4', '#4fc3f7', '#ffb020', '#ff4d6d'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function debounce(fn, ms) { let t; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); }; }
function placeShort(p) { return String(p || '').replace(/^Panam[aá] a /i, ''); }

/* ---------- Configuración ---------- */
const DEF = {
  city: 'pty', lat: 8.98, lon: -79.52, gps: true, m1: 3.5, m2: 5, full: 2, replicas: true,
  sound: true, vol: 0.85, profile: 'istmo', voice: true, vib: true, sensor: true, sens: 2,
  persist: true, wake: true, kiosk: false, dim: false, map: 'vec', range: '24h', minMag: 0, onlyPan: true,
  links: true, waves: true, heat: false, push: false
};
let cfg = Object.assign({}, DEF, LS.get('cfg', {}));
let user = { lat: cfg.lat, lon: cfg.lon };
function setUser() {
  const c = CITIES.find((x) => x[0] === cfg.city);
  if (cfg.city === 'gps') { const g = LS.get('gpsPos', null); user = g || { lat: cfg.lat, lon: cfg.lon }; }
  else if (cfg.city === 'custom') user = { lat: cfg.lat, lon: cfg.lon };
  else if (c) user = { lat: c[2], lon: c[3] };
}
setUser();
function userName() { if (cfg.city === 'gps') return 'tu ubicación (GPS)'; if (cfg.city === 'custom') return 'tu ubicación'; const c = CITIES.find((x) => x[0] === cfg.city); return c ? c[1] : 'Ciudad de Panamá'; }
function saveCfg() {
  LS.set('cfg', cfg); setUser();
  try { caches.open('sismo-meta').then((c) => c.put('/cfg', new Response(JSON.stringify({ lat: user.lat, lon: user.lon, m1: cfg.m1 })))); } catch (e) { }
  if (typeof pushSync === 'function') pushSync();
  if (Snd) Snd.apply();
}

/* ---------- Avisos en pantalla ---------- */
function toast(title, sub, kind, ms, onclick) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.innerHTML = '<div style="flex:1;min-width:0"><b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  if (onclick) { el.style.cursor = 'pointer'; el.addEventListener('click', () => { onclick(); el.remove(); }); }
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, ms || 5200);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}
function vib(p) { if (cfg.vib && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { } } }

/* ---------- Voz ---------- */
function speak(t) {
  if (!cfg.voice || !cfg.sound || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(t), vs = speechSynthesis.getVoices();
    const v = vs.find((x) => /^es[-_](PA|419|MX|US|CO)/i.test(x.lang)) || vs.find((x) => /^es/i.test(x.lang));
    if (v) u.voice = v; u.lang = (v && v.lang) || 'es-419'; u.rate = 1.02; u.volume = clamp(cfg.vol + 0.1, 0, 1);
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) { }
}

/* ---------- Motor de sonido (WebAudio, sin archivos) ----------
   istmo  : pings tipo sonar + arpegio ascendente + sirena con rumor grave
   clasico: dos tonos 853 + 960 Hz (estilo sistemas de alerta de emergencia)
   suave  : campanas suaves (siempre con sirena completa en PELIGRO) */
const Snd = (() => {
  let ctx = null, master = null, bus = null, noiseBuf = null, siren = null;
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => { }); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
    master = ctx.createGain(); master.gain.value = cfg.sound ? cfg.vol : 0; master.connect(comp); comp.connect(ctx.destination);
    bus = ctx.createGain(); bus.connect(master);
    const dl = ctx.createDelay(1); dl.delayTime.value = 0.24; const fb = ctx.createGain(); fb.gain.value = 0.3; const wet = ctx.createGain(); wet.gain.value = 0.28;
    bus.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  function apply() { if (master) master.gain.setTargetAtTime(cfg.sound ? cfg.vol : 0, ctx.currentTime, 0.03); }
  function env(g, t0, a, d, peak) { g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); }
  function tone(f, t0, dur, o) {
    o = o || {}; const os = ctx.createOscillator(), g = ctx.createGain(); os.type = o.type || 'sine'; os.frequency.setValueAtTime(f, t0);
    if (o.f2) os.frequency.exponentialRampToValueAtTime(o.f2, t0 + dur);
    os.connect(g); g.connect(o.dry ? master : bus); env(g, t0, o.a || 0.01, dur, o.peak || 0.3); os.start(t0); os.stop(t0 + (o.a || 0.01) + dur + 0.06);
  }
  function noise(t0, dur, o) {
    o = o || {}; const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noiseBuf; f.type = o.type || 'lowpass'; f.frequency.value = o.f || 400;
    s.connect(f); f.connect(g); g.connect(o.dry ? master : bus); env(g, t0, o.a || 0.01, dur, o.peak || 0.4); s.start(t0, Math.random()); s.stop(t0 + (o.a || 0.01) + dur + 0.05);
  }
  const P = {
    info(t) {
      if (cfg.profile === 'clasico') { tone(880, t, 0.28, { type: 'triangle', peak: 0.25 }); tone(1100, t + 0.3, 0.4, { type: 'triangle', peak: 0.25 }); }
      else if (cfg.profile === 'suave') { tone(660, t, 0.9, { peak: 0.22 }); tone(990, t + 0.14, 0.9, { peak: 0.16 }); }
      else { tone(1320, t, 1.0, { peak: 0.3 }); tone(1760, t + 0.16, 0.9, { peak: 0.2 }); tone(660, t, 1.1, { peak: 0.12 }); }
    },
    alert(t) {
      if (cfg.profile === 'clasico') { for (let i = 0; i < 3; i++) { tone(853, t + i * 0.8, 0.6, { type: 'sine', peak: 0.34, a: 0.01, dry: true }); tone(960, t + i * 0.8, 0.6, { type: 'sine', peak: 0.34, a: 0.01, dry: true }); } }
      else if (cfg.profile === 'suave') { [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.18, 0.9, { peak: 0.26 })); }
      else { for (let r = 0; r < 2; r++) [523, 659, 784, 1047].forEach((f, i) => tone(f, t + r * 0.9 + i * 0.13, 0.5, { type: 'square', peak: 0.16 })); tone(130, t, 1.6, { peak: 0.3, dry: true }); }
    },
    replica(t) { tone(110, t, 0.45, { f2: 42, peak: 0.55, dry: true }); noise(t, 0.35, { f: 260, peak: 0.45 }); tone(440, t + 0.38, 0.35, { peak: 0.14 }); },
    local(t) { for (let i = 0; i < 4; i++) tone(1500, t + i * 0.16, 0.09, { type: 'square', peak: 0.2, dry: true }); },
    clear(t) { [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.2, 1.3, { peak: 0.2 })); },
    swave(t) { tone(70, t, 1.5, { f2: 28, peak: 0.7, dry: true }); noise(t, 1.2, { f: 200, peak: 0.7 }); },
    tick(t) { tone(1000, t, 0.03, { type: 'square', peak: 0.18, dry: true }); },
    tickU(t) { tone(1800, t, 0.05, { type: 'square', peak: 0.28, dry: true }); },
    test(t) { P.info(t); }
  };
  function play(n) { const c = init(); if (!c || !cfg.sound) return; try { P[n](c.currentTime + 0.03); } catch (e) { } }
  function startSiren() {
    const c = init(); if (!c || !cfg.sound || siren) return;
    const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = 820; lfo.type = 'triangle'; lfo.frequency.value = 0.8; lg.gain.value = 330; f.type = 'lowpass'; f.frequency.value = 2400; g.gain.value = 0.0001;
    lfo.connect(lg); lg.connect(o.frequency); o.connect(f); f.connect(g); g.connect(master);
    g.gain.exponentialRampToValueAtTime(0.5, c.currentTime + 0.25);
    const n = c.createBufferSource(), nf = c.createBiquadFilter(), ng = c.createGain(), tr = c.createOscillator(), trg = c.createGain(), sub = c.createOscillator(), sg = c.createGain();
    n.buffer = noiseBuf; n.loop = true; nf.type = 'lowpass'; nf.frequency.value = 130; ng.gain.value = 0.55; tr.frequency.value = 6.5; trg.gain.value = 0.35; tr.connect(trg); trg.connect(ng.gain);
    n.connect(nf); nf.connect(ng); ng.connect(master); sub.type = 'sine'; sub.frequency.value = 46; sg.gain.value = 0.35; sub.connect(sg); sg.connect(master);
    o.start(); lfo.start(); n.start(); tr.start(); sub.start();
    siren = { stop() { const t = c.currentTime; try { g.gain.setTargetAtTime(0.0001, t, 0.12); ng.gain.setTargetAtTime(0.0001, t, 0.12); sg.gain.setTargetAtTime(0.0001, t, 0.12); setTimeout(() => { [o, lfo, n, tr, sub].forEach((x) => { try { x.stop(); } catch (e) { } }); }, 600); } catch (e) { } } };
  }
  function stopSiren() { if (siren) { siren.stop(); siren = null; } }
  return { init, apply, play, startSiren, stopSiren, get ctx() { return ctx; } };
})();
const SOUND_LIST = [['info', 'Informativo', 'Sismo menor en Panamá'], ['alert', 'Alerta', 'Sismo moderado o cercano'], ['replica', 'Réplica', 'Golpe grave + campanilla'], ['swave', 'Llegada onda S', 'Impacto grave'], ['local', 'Sensor local', 'Movimiento detectado'], ['clear', 'Todo despejado', 'Fin de la alerta']];
