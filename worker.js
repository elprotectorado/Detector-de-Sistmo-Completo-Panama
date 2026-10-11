/* =====================================================================
   SISMO PANAMÁ · ISTMO — Cloudflare Worker (app + API + PWA + Web Push)
   By @elprotectorado
   Fuentes: IGC-UP (Instituto de Geociencias, Univ. de Panamá) · USGS · EMSC
   Opcional para alertas con la app CERRADA: KV binding "SISMO_KV" + Cron "* * * * *"
   ===================================================================== */

/* ========= NÚCLEO COMPARTIDO (servidor + página + service worker) ========= */
const PAN = { minlat: 4.5, maxlat: 10.5, minlon: -84.0, maxlon: -76.5 };   // Panamá, Zona de Fractura, Darién
const REG = { minlat: -2.0, maxlat: 16.0, minlon: -93.0, maxlon: -68.0 };  // Centroamérica + norte de Sudamérica
const VP = 6.0, VS = 3.5; // km/s: velocidad típica onda P y S en corteza

const CITIES = [
  ['pty', 'Ciudad de Panamá', 8.98, -79.52], ['sanm', 'San Miguelito', 9.03, -79.50], ['colon', 'Colón', 9.36, -79.90],
  ['david', 'David (Chiriquí)', 8.43, -82.43], ['santiago', 'Santiago (Veraguas)', 8.10, -80.98], ['chitre', 'Chitré (Herrera)', 7.96, -80.43],
  ['lstos', 'Las Tablas (Los Santos)', 7.77, -80.28], ['penonome', 'Penonomé (Coclé)', 8.52, -80.36], ['chorrera', 'La Chorrera', 8.88, -79.78],
  ['bocas', 'Bocas del Toro', 9.34, -82.24], ['puertoarm', 'Puerto Armuelles', 8.28, -82.87], ['volcan', 'Volcán (Chiriquí)', 8.77, -82.63],
  ['yaviza', 'Darién (Yaviza)', 8.16, -77.69], ['guna', 'Guna Yala (El Porvenir)', 9.56, -78.96], ['sona', 'Soná', 8.00, -81.31],
  ['tonosi', 'Tonosí', 7.41, -80.44], ['changui', 'Changuinola', 9.43, -82.52]
];

function rad(d) { return d * Math.PI / 180; }
function kmDist(a, b) {
  const dl = rad(b.lat - a.lat), dn = rad(b.lon - a.lon);
  const x = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) * Math.sin(dn / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(x)));
}
function inBox(p, b) { return p.lat >= b.minlat && p.lat <= b.maxlat && p.lon >= b.minlon && p.lon <= b.maxlon; }

/* Nivel de alerta para un usuario en `u`: 0 nada · 1 informativo · 2 alerta · 3 peligro */
function levelFor(q, u) {
  if (q.local) return 2;
  const d = kmDist(u, q), p = inBox(q, PAN), m = q.mag;
  if ((m >= 6 && d < 700) || (p && m >= 5 && d < 350)) return 3;
  if ((p && m >= 4) || (m >= 5.5 && d < 1200) || (m >= 5 && d < 300)) return 2;
  if ((p && m >= 2.5) || (m >= 4.5 && d < 800)) return 1;
  return 0;
}
/* ¿Dos reportes (redes distintas) son el mismo sismo? */
function sameEvent(a, b) { return Math.abs(a.t - b.t) < 100000 && kmDist(a, b) < 120; }

/* Ventanas de secuencia: distancia de Gardner-Knopoff (1974); tiempo acotado a uso práctico */
function gkDist(M) { return Math.pow(10, 0.1238 * M + 0.983); }
function seqDays(M) { return Math.pow(10, 0.35 * M - 1.1); }

/* Clasifica cada evento: 'main' (con réplicas), 'after' (réplica), 'fore' (posible premonitor), 'single'. Muta y devuelve Q. */
function annotate(Q) {
  const asc = Q.slice().sort((a, b) => a.t - b.t), mains = [], byId = {};
  for (const e of asc) { e.role = 'single'; e.main = null; e.nrep = 0; e.nfore = 0; byId[e.id] = e; }
  for (const e of asc) {
    let best = null;
    for (const m of mains) {
      if (m.mag <= e.mag) continue;
      const dt = (e.t - m.t) / 864e5;
      if (dt < 0 || dt > seqDays(m.mag)) continue;
      if (kmDist(m, e) > gkDist(m.mag)) continue;
      if (!best || m.mag > best.mag) best = m;
    }
    if (best) { e.role = 'after'; e.main = best.id; best.nrep++; best.role = 'main'; }
    else if (e.mag >= 4) mains.push(e);
  }
  for (const m of mains) {
    if (m.mag < 4.5) continue;
    for (const f of asc) {
      if (f.t >= m.t) break;
      if (f.role !== 'single' || f.mag >= m.mag) continue;
      if ((m.t - f.t) / 864e5 > 2 || kmDist(m, f) > gkDist(m.mag)) continue;
      f.role = 'fore'; f.main = m.id; m.nfore++;
    }
    if (m.nfore > 0 && m.role === 'single') m.role = 'main';
  }
  return Q;
}

/* Probabilidad de al menos una réplica ≥ Mth en las próximas `span` días (Reasenberg & Jones 1989, parámetros genéricos).
   ageDays = tiempo desde el sismo principal. Es una ESTIMACIÓN no calibrada para Panamá. */
function aftershockProb(Mm, ageDays, Mth, span) {
  const a = -1.67, b = 0.91, p = 1.08, c = 0.05, t1 = Math.max(ageDays, 0.002), t2 = t1 + (span || 1);
  const I = (Math.pow(t2 + c, 1 - p) - Math.pow(t1 + c, 1 - p)) / (1 - p);
  return 1 - Math.exp(-Math.pow(10, a + b * (Mm - Mth)) * I);
}
function energyJ(M) { return Math.pow(10, 1.5 * M + 4.8); }
/* Radio aproximado (km) donde un sismo suele ser sentido — heurística */
function feltKm(M) { return Math.pow(10, 0.45 * M - 0.1); }


const VERSION = '2.0.mv3bz80s';
const IGC_URL = 'https://sismosgeociencias.up.ac.pa/';
const IGC_TZ = '-05:00'; // Panamá no usa horario de verano
const UA = 'Mozilla/5.0 (compatible; SismoPanamaISTMO/2.0; +https://github.com/elprotectorado)';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const enc = new TextEncoder();

/* ---------------- Utilidades ---------------- */
function json(data, status, extra) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=10' }, CORS, extra || {}) });
}
function text(body, type, extra) { return new Response(body, { headers: Object.assign({ 'content-type': type }, extra || {}) }); }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19); }
function concat() { let n = 0; for (const a of arguments) n += a.length; const o = new Uint8Array(n); let i = 0; for (const a of arguments) { o.set(a, i); i += a.length; } return o; }
function b64u(buf) { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function sha1hex(s) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); let o = ''; for (let i = 0; i < 16; i++) o += h[i].toString(16).padStart(2, '0'); return o; }

/* ---------------- IGC-UP → API (parser del listado HTML) ---------------- */
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü' };
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (ENT[n] !== undefined ? ENT[n] : m));
}
function parseHora(h) { // "8:50:52PM" → [20,50,52]
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(h || '');
  if (!m) return null;
  let hh = +m[1] % 12; if (m[4].toLowerCase() === 'p') hh += 12;
  return [hh, +m[2], +(m[3] || 0)];
}
function igcRecord(f, h, lat, lon, depthStr, mag, estado, region) {
  const hm = parseHora(h); lat = parseFloat(lat); lon = parseFloat(lon); mag = parseFloat(mag);
  if (!hm || !/^\d{4}-\d{2}-\d{2}$/.test(f) || !isFinite(lat) || !isFinite(lon) || !isFinite(mag) || mag < -2 || mag > 10) return null;
  const t = Date.parse(f + 'T' + String(hm[0]).padStart(2, '0') + ':' + String(hm[1]).padStart(2, '0') + ':' + String(hm[2]).padStart(2, '0') + IGC_TZ);
  if (!isFinite(t)) return null;
  const place = decodeEntities(String(region || '')).replace(/\s+/g, ' ').replace(/^Localizado\s+en\s+/i, '').trim().slice(0, 140) || 'Panamá';
  const depth = parseFloat(depthStr); const st = /revis/i.test(estado || '') ? 'R' : 'P';
  return {
    id: 'I' + Math.round(t / 1000) + '_' + Math.round(lat * 1000), src: 'IGC', t, lat, lon, depth: isFinite(depth) ? depth : 0, mag, place, st,
    url: IGC_URL + 'ultimosismo.html?z=9&lt=' + lat + '&ln=' + lon + '&p=' + (isFinite(depth) ? depth : 0) + 'km&e=' + (st === 'R' ? 'REVISADO' : 'PRELIMINAR') + '&h=' + encodeURIComponent(h) + '&f=' + f + '&m=' + mag
  };
}
function parseIGC(html) {
  const out = new Map(), key = (r) => r.t + '|' + r.lat + '|' + r.lon;
  // Estrategia A — enlaces "Ver" (llevan todos los campos en la URL): ultimosismo.html?z=9&lt=..&ln=..&p=..&e=..&h=..&f=..&m=..&r=..
  const re = /ultimosismo\.html\?([^"'<>\s)]+)/gi; let m;
  while ((m = re.exec(html))) {
    const q = {};
    m[1].replace(/&amp;/g, '&').split('&').forEach((kv) => {
      const i = kv.indexOf('='); if (i < 1) return;
      let k = kv.slice(0, i).replace(/^amp;/, '').toLowerCase(), v = kv.slice(i + 1);
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { }
      q[k] = v;
    });
    const r = igcRecord(q.f, q.h, q.lt || q.lat, q.ln || q.lon, q.p, q.m, q.e, q.r);
    if (r) out.set(key(r), r);
  }
  // Estrategia B — texto de la tabla (funciona aunque cambie el marcado): ESTADO FECHA HORA LAT LON PROF MAG REGIÓN
  const plain = decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\|/g, ' ').replace(/\s+/g, ' ');
  const rr = /(PRELIMINAR|REVISADO)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}:\d{2}\s*[AP]\.?\s?M\.?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*km\s+(\d+(?:\.\d+)?)\s+([\s\S]*?)(?=\s+(?:PRELIMINAR|REVISADO)\s+\d{4}-\d{2}-\d{2}|\s*$)/gi;
  while ((m = rr.exec(plain))) {
    const region = m[8].split(/\s+Ver(?:\s|$)/i)[0].split(/\s+Estado\s+(?:PRELIMINAR|REVISADO)/i)[0];
    const r = igcRecord(m[2], m[3], m[4], m[5], m[6], m[7], m[1], region);
    if (r && !out.has(key(r))) out.set(key(r), r);
  }
  return Array.from(out.values());
}

/* ---------------- USGS / EMSC ---------------- */
async function getJSON(url, ms) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 10, cacheEverything: true }, signal: AbortSignal.timeout(ms || 8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function usgsURL(b, minmag, days) {
  return 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventtype=earthquake&orderby=time&limit=400' +
    '&minlatitude=' + b.minlat + '&maxlatitude=' + b.maxlat + '&minlongitude=' + b.minlon + '&maxlongitude=' + b.maxlon +
    '&minmagnitude=' + minmag + '&starttime=' + iso(Date.now() - days * 864e5);
}
function emscURL(b, minmag, days) {
  return 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&orderby=time&limit=400' +
    '&minlat=' + b.minlat + '&maxlat=' + b.maxlat + '&minlon=' + b.minlon + '&maxlon=' + b.maxlon +
    '&minmag=' + minmag + '&start=' + iso(Date.now() - days * 864e5);
}
function normUSGS(j) {
  return (j.features || []).map((f) => {
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    return {
      id: 'U' + f.id, src: 'USGS', t: p.time, lat: c[1], lon: c[0], depth: c[2] == null ? 0 : c[2], mag: p.mag, place: p.place || 'Sin nombre',
      st: p.status === 'reviewed' ? 'R' : 'P', url: p.url, tsunami: p.tsunami ? 1 : 0, alert: p.alert || null, felt: p.felt || 0, mmi: p.mmi || null, sig: p.sig || 0
    };
  }).filter((q) => q.mag != null && isFinite(q.lat) && isFinite(q.lon) && isFinite(q.t));
}
function normEMSC(j) {
  return (j.features || []).map((f) => {
    const p = f.properties || {};
    return {
      id: 'E' + (p.unid || f.id), src: 'EMSC', t: Date.parse(p.time), lat: +p.lat, lon: +p.lon, depth: Math.abs(+p.depth || 0), mag: +p.mag,
      place: p.flynn_region || 'Sin nombre', st: 'P', evtype: p.evtype,
      url: p.unid ? 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=' + p.unid : undefined
    };
  }).filter((q) => isFinite(q.mag) && isFinite(q.t) && isFinite(q.lat) && isFinite(q.lon) && (!q.evtype || q.evtype === 'ke'));
}
async function fetchIGC() {
  const r = await fetch(IGC_URL, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, cf: { cacheTtl: 15, cacheEverything: true }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const list = parseIGC(await r.text());
  if (!list.length) throw new Error('El listado no contiene sismos legibles (¿cambió el formato?)');
  return list;
}

/* ---------------- Fusión multi-fuente ---------------- */
const PRIO = { IGC: 0, USGS: 1, EMSC: 2 };
function merge(all) {
  all.sort((a, b) => a.t - b.t);
  const groups = [];
  for (const e of all) {
    let g = null;
    for (let i = groups.length - 1; i >= 0 && e.t - groups[i].t0 < 120000; i--) {
      const c = groups[i];
      if (!c.m.some((x) => x.src === e.src) && kmDist(c.m[0], e) < 120) { g = c; break; }
    }
    if (g) g.m.push(e); else groups.push({ t0: e.t, m: [e] });
  }
  return groups.map((g) => {
    const m = g.m.slice().sort((a, b) => PRIO[a.src] - PRIO[b.src]), p = m[0], mags = {}, links = {};
    m.forEach((x) => { mags[x.src] = x.mag; if (x.url) links[x.src] = x.url; });
    const us = m.find((x) => x.src === 'USGS');
    return {
      id: p.id, t: p.t, lat: p.lat, lon: p.lon, depth: p.depth, mag: p.mag, place: p.place, st: p.st, src: m.map((x) => x.src), mags, links,
      tsunami: us ? us.tsunami : 0, alert: us ? us.alert : null, felt: us ? us.felt : 0, mmi: us ? us.mmi : null, sig: us ? us.sig : 0
    };
  }).sort((a, b) => b.t - a.t);
}

/* ---------------- Base de datos en memoria (con reutilización de último dato bueno) ---------------- */
const MEM = { base: null, at: 0, inflight: null, good: {}, icons: {}, vapid: null };
function srcRun(name, promises) {
  return Promise.allSettled(promises).then((rs) => {
    const ok = rs.filter((r) => r.status === 'fulfilled'), data = [].concat(...ok.map((r) => r.value));
    const err = rs.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message || r.reason)).join(' | ');
    const now = Date.now();
    if (ok.length) { MEM.good[name] = { at: now, data }; return { name, ok: true, stale: false, n: data.length, err: err || null, at: now, data }; }
    const g = MEM.good[name];
    if (g && now - g.at < 30 * 60000) return { name, ok: false, stale: true, n: g.data.length, err, at: g.at, data: g.data };
    return { name, ok: false, stale: false, n: 0, err, at: now, data: [] };
  });
}
async function buildBase() {
  const t0 = Date.now();
  const timed = async (name, ps) => { const s = Date.now(); const r = await srcRun(name, ps); r.ms = Date.now() - s; return r; };
  const [igc, usgs, emsc] = await Promise.all([
    timed('IGC', [fetchIGC()]),
    timed('USGS', [getJSON(usgsURL(PAN, 1, 7)).then(normUSGS), getJSON(usgsURL(REG, 4.5, 4)).then(normUSGS)]),
    timed('EMSC', [getJSON(emscURL(PAN, 1.5, 7)).then(normEMSC), getJSON(emscURL(REG, 4.5, 4)).then(normEMSC)])
  ]);
  const cutoff = Date.now() - 8 * 864e5;
  const all = [].concat(igc.data, usgs.data, emsc.data).filter((q) => q.t > cutoff && inBox(q, REG));
  const quakes = annotate(merge(all));
  const sources = {};
  [igc, usgs, emsc].forEach((s) => { sources[s.name] = { ok: s.ok, stale: s.stale, n: s.n, ms: s.ms, err: s.err, at: s.at }; });
  return { updated: Date.now(), took: Date.now() - t0, version: VERSION, sources, quakes };
}
async function getBase(force) {
  const now = Date.now();
  if (!force && MEM.base && now - MEM.at < 15000) return MEM.base;
  if (MEM.inflight) return MEM.inflight;
  MEM.inflight = buildBase().then((b) => { MEM.base = b; MEM.at = Date.now(); return b; }).finally(() => { MEM.inflight = null; });
  return MEM.inflight;
}

/* ---------------- Filtros, formatos, estadísticas ---------------- */
function filterQuakes(list, sp) {
  const min = parseFloat(sp.get('min')), max = parseFloat(sp.get('max')), days = parseFloat(sp.get('days')), limit = parseInt(sp.get('limit'), 10);
  let since = sp.get('since'); since = since ? (isNaN(+since) ? Date.parse(since) : +since) : null;
  const region = sp.get('region'), src = (sp.get('src') || '').toUpperCase(), role = sp.get('role'), st = (sp.get('st') || '').toUpperCase();
  let out = list.filter((q) => {
    if (isFinite(min) && q.mag < min) return false;
    if (isFinite(max) && q.mag > max) return false;
    if (isFinite(days) && Date.now() - q.t > days * 864e5) return false;
    if (since && q.t < since) return false;
    if (region === 'pan' && !inBox(q, PAN)) return false;
    if (src && q.src.indexOf(src) < 0) return false;
    if (role && q.role !== role) return false;
    if (st && q.st !== st) return false;
    return true;
  });
  if (isFinite(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}
function toGeoJSON(list, extra) {
  return Object.assign({
    type: 'FeatureCollection', features: list.map((q) => ({
      type: 'Feature', id: q.id, geometry: { type: 'Point', coordinates: [q.lon, q.lat, -q.depth] },
      properties: { time: q.t, iso: new Date(q.t).toISOString(), mag: q.mag, depth_km: q.depth, place: q.place, status: q.st === 'R' ? 'revisado' : 'preliminar', sources: q.src, magnitudes: q.mags, role: q.role, replicas: q.nrep, url: (q.links && (q.links.IGC || q.links.USGS || q.links.EMSC)) || q.url, tsunami: q.tsunami }
    }))
  }, extra || {});
}
function bValue(mags) {
  if (mags.length < 30) return null;
  const bins = {}; mags.forEach((m) => { const k = Math.round(m * 10) / 10; bins[k] = (bins[k] || 0) + 1; });
  let mc = 0, best = -1; Object.keys(bins).forEach((k) => { if (bins[k] > best) { best = bins[k]; mc = +k; } });
  const sel = mags.filter((m) => m >= mc); if (sel.length < 20) return null;
  const mean = sel.reduce((a, b) => a + b, 0) / sel.length;
  return { b: Math.log10(Math.E) / (mean - (mc - 0.05)), mc, n: sel.length };
}
function statsOf(list) {
  const now = Date.now(), pan = list.filter((q) => inBox(q, PAN)), perDay = [];
  for (let i = 6; i >= 0; i--) {
    const a = now - (i + 1) * 864e5, b = now - i * 864e5, d = pan.filter((q) => q.t >= a && q.t < b);
    perDay.push({ from: iso(a), n: d.length, max: d.reduce((m, q) => Math.max(m, q.mag), 0) });
  }
  const byMag = {}; pan.forEach((q) => { const k = Math.floor(q.mag); byMag[k] = (byMag[k] || 0) + 1; });
  const top = pan.reduce((m, q) => (!m || q.mag > m.mag ? q : m), null);
  return {
    panama: { h24: pan.filter((q) => now - q.t < 864e5).length, d7: pan.length, m4_d7: pan.filter((q) => q.mag >= 4).length, max_d7: top ? { mag: top.mag, place: top.place, t: top.t } : null },
    perDay, byMagnitude: byMag, gutenberg_richter: bValue(pan.map((q) => q.mag)),
    energy_J_d7: pan.reduce((a, q) => a + energyJ(q.mag), 0)
  };
}
function sequencesOf(list) {
  const now = Date.now();
  return list.filter((q) => (q.role === 'main' || (q.mag >= 4.5 && q.role !== 'after')) && now - q.t < 8 * 864e5 && inBox(q, REG)).map((m) => {
    const age = (now - m.t) / 864e5, reps = list.filter((q) => q.main === m.id && q.role === 'after');
    return {
      id: m.id, mag: m.mag, place: m.place, t: m.t, depth: m.depth, replicas: reps.length, replicas_24h: reps.filter((q) => now - q.t < 864e5).length,
      max_replica: reps.reduce((a, q) => Math.max(a, q.mag), 0), foreshocks: m.nfore || 0,
      forecast_24h: { note: 'Estimación genérica (Reasenberg & Jones 1989), no calibrada para Panamá', p_m4: aftershockProb(m.mag, age, 4, 1), p_m5: aftershockProb(m.mag, age, 5, 1), p_m6: aftershockProb(m.mag, age, 6, 1) }
    };
  });
}

/* ---------------- Web Push (VAPID + cifrado aes128gcm, RFC 8291/8292) ---------------- */
function okPushHost(u) {
  try {
    const x = new URL(u), h = x.hostname;
    return x.protocol === 'https:' && (/(^|\.)googleapis\.com$/.test(h) || /(^|\.)push\.apple\.com$/.test(h) || /(^|\.)mozilla\.com$/.test(h) || /(^|\.)mozaws\.net$/.test(h) || /(^|\.)notify\.windows\.com$/.test(h));
  } catch (e) { return false; }
}
async function getVapid(env) {
  if (MEM.vapid) return MEM.vapid;
  let v = await env.SISMO_KV.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.SISMO_KV.put('vapid', JSON.stringify(v));
  }
  MEM.vapid = v; return v;
}
async function vapidAuth(env, endpoint) {
  const v = await getVapid(env);
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://github.com/elprotectorado' })));
  const key = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + c));
  return 'vapid t=' + h + '.' + c + '.' + b64u(sig) + ', k=' + v.pub;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function encryptPush(sub, payload) {
  const uaPub = unb64u(sub.p), auth = unb64u(sub.a);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(auth, secret, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(payload), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
}
async function sendPush(env, sub, payload, urgency) {
  const body = await encryptPush(sub, JSON.stringify(payload));
  const r = await fetch(sub.e, {
    method: 'POST', body,
    headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '7200', urgency: urgency || 'high', authorization: await vapidAuth(env, sub.e) },
    signal: AbortSignal.timeout(8000)
  });
  return r.status;
}
async function listSubs(env) {
  const subs = []; let cursor;
  for (let i = 0; i < 10; i++) {
    const r = await env.SISMO_KV.list({ prefix: 's:', cursor });
    r.keys.forEach((k) => { if (k.metadata && k.metadata.e) subs.push({ key: k.name, ...k.metadata }); });
    if (r.list_complete) break; cursor = r.cursor;
  }
  return subs.sort((a, b) => (a.key < b.key ? -1 : 1));
}
function ago(ms) { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 90 ? 'hace instantes' : s < 3600 ? 'hace ' + Math.round(s / 60) + ' min' : 'hace ' + Math.round(s / 3600) + ' h'; }
function pushText(q, lvl, user, kind) {
  const d = Math.round(kmDist(user, q)), est = q.st === 'R' ? '' : ' · preliminar';
  const head = kind === 'upd' ? 'ACTUALIZADO · ' : '';
  const title = q.role === 'after' && q.mag < 4.5 ? head + '↺ Réplica M' + q.mag.toFixed(1)
    : lvl === 3 ? head + '🔴 SISMO FUERTE · M' + q.mag.toFixed(1) : lvl === 2 ? head + '🟠 ALERTA · M' + q.mag.toFixed(1) : head + '🔵 Sismo M' + q.mag.toFixed(1);
  return { title, body: q.place + ' · prof. ' + Math.round(q.depth) + ' km · a ' + d + ' km de ti · ' + ago(q.t) + est + (q.tsunami ? ' · posible tsunami: consulta SINAPROC' : '') };
}
async function runPushJob(env) {
  if (!env.SISMO_KV) return { skipped: 'sin KV' };
  const base = await getBase(true), now = Date.now();
  let st = await env.SISMO_KV.get('state', 'json');
  if (!st) { // primera vez: marca lo existente como ya notificado para no inundar
    st = { n: base.quakes.filter((q) => now - q.t < 6 * 3600e3).map((q) => [q.t, q.lat, q.lon, q.mag, 1e9]) };
    await env.SISMO_KV.put('state', JSON.stringify(st)); return { init: st.n.length };
  }
  const notified = st.n.filter((x) => now - x[0] < 6 * 3600e3);
  const cands = base.quakes.filter((q) => now - q.t < 3 * 3600e3 && q.mag >= 2.5).sort((a, b) => a.t - b.t);
  let subs = null, budget = parseInt(env.PUSH_BUDGET, 10) || 40, sent = 0, dead = [], changed = false;
  for (const q of cands) {
    let e = notified.find((x) => sameEvent({ t: x[0], lat: x[1], lon: x[2] }, q));
    if (!e) { e = [q.t, q.lat, q.lon, q.mag, 0, 'new']; notified.push(e); changed = true; }
    else if (e[4] >= 1e9 && q.mag >= e[3] + 0.5) { e[3] = q.mag; e[4] = 0; e[5] = 'upd'; changed = true; }
    else if (e[4] >= 1e9) continue;
    const kind = e[5] || 'new';
    if (!subs) subs = await listSubs(env);
    while (e[4] < subs.length && budget > 0) {
      const s = subs[e[4]++]; changed = true;
      const u = { lat: s.la, lon: s.lo }, lvl = levelFor(q, u), pan = inBox(q, PAN), thr = pan ? s.m1 : s.m2;
      const isRep = q.role === 'after' && q.mag < 4.5;
      if (!(lvl >= 2 || q.mag >= thr) || (isRep && !s.r && lvl < 2)) continue;
      const tx = pushText(q, lvl, u, kind);
      budget--; sent++;
      try {
        const code = await sendPush(env, { e: s.e, p: s.p, a: s.a }, { title: tx.title, body: tx.body, id: q.id, tag: 'q-' + q.id, lvl, mag: q.mag, lat: q.lat, lon: q.lon, t: q.t, kind }, lvl >= 2 ? 'high' : 'normal');
        if (code === 404 || code === 410) dead.push(s.key);
      } catch (err) { }
    }
    if (e[4] >= subs.length) e[4] = 1e9; // terminado
    if (budget <= 0) break;
  }
  for (const k of dead) await env.SISMO_KV.delete(k);
  if (changed) await env.SISMO_KV.put('state', JSON.stringify({ n: notified }));
  return { sent, dead: dead.length };
}

/* ---------------- Iconos PNG generados (instalación en Android / iOS / escritorio) ---------------- */
let CRC_T = null;
function crc32(u8) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const o = new Uint8Array(12 + data.length), dv = new DataView(o.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
  o.set(data, 8); dv.setUint32(8 + data.length, crc32(o.subarray(4, 8 + data.length))); return o;
}
async function encodePNG(w, h, rgba, scale) {
  const W = w * scale, H = h * scale, raw = new Uint8Array((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const ro = y * (W * 4 + 1), sy = Math.floor(y / scale); raw[ro] = 0;
    for (let x = 0; x < W; x++) { const si = (sy * w + Math.floor(x / scale)) * 4, di = ro + 1 + x * 4; raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1]; raw[di + 2] = rgba[si + 2]; raw[di + 3] = rgba[si + 3]; }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 6;
  return concat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0)));
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py; return Math.sqrt(x * x + y * y);
}
function renderIcon(n) {
  const px = new Uint8Array(n * n * 4), Z = [[.14, .5], [.32, .5], [.39, .5], [.45, .3], [.53, .7], [.6, .4], [.65, .5], [.86, .5]];
  const rings = [.15, .25, .35], hw = Math.max(1, n * 0.011), lw = Math.max(1.4, n * 0.024);
  const mix = (a, b, t) => a + (b - a) * t, cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + .5) / n, v = (y + .5) / n, dx = u - .5, dy = v - .5, r = Math.sqrt(dx * dx + dy * dy), g = cl(r * 1.5);
    let R = mix(12, 4, g), G = mix(42, 10, g), B = mix(60, 18, g);
    for (let i = 0; i < 3; i++) { const cv = cl(hw - Math.abs(r - rings[i]) * n + .5) * (0.85 - i * .22); R = mix(R, 39, cv); G = mix(G, 240, cv); B = mix(B, 196, cv); }
    if (Math.abs(dy) < .26) {
      let d = 9e9; for (let i = 0; i < Z.length - 1; i++) { const s = segDist(u * n, v * n, Z[i][0] * n, Z[i][1] * n, Z[i + 1][0] * n, Z[i + 1][1] * n); if (s < d) d = s; }
      const c1 = cl(lw - d + .5), c2 = cl(lw * .4 - d + .5);
      R = mix(R, 255, c1); G = mix(G, 77, c1); B = mix(B, 109, c1); R = mix(R, 255, c2 * .8); G = mix(G, 220, c2 * .8); B = mix(B, 228, c2 * .8);
    }
    const o = (y * n + x) * 4; px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
  }
  return px;
}
async function iconPNG(size) {
  if (MEM.icons[size]) return MEM.icons[size];
  const base = size >= 512 ? 256 : size, scale = size >= 512 ? 2 : 1;
  const png = await encodePNG(base, base, renderIcon(base), scale); MEM.icons[size] = png; return png;
}
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="g" cx=".5" cy=".5" r=".75"><stop offset="0" stop-color="#0c2a3c"/><stop offset="1" stop-color="#040a12"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><g fill="none" stroke="#27f0c4"><circle cx="256" cy="256" r="77" stroke-width="11" opacity=".85"/><circle cx="256" cy="256" r="128" stroke-width="11" opacity=".6"/><circle cx="256" cy="256" r="179" stroke-width="11" opacity=".38"/></g><path d="M72 256h92l36 0 26-102 64 204 38-144 21 42h91" fill="none" stroke="#ff4d6d" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><path d="M72 256h92l36 0 26-102 64 204 38-144 21 42h91" fill="none" stroke="#ffd7e0" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/></svg>`;

/* ---------------- Recursos estáticos ---------------- */
const HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#040a12">
<meta name="color-scheme" content="dark">
<meta name="description" content="Sismo Panamá · ISTMO — vigilancia sísmica en tiempo real con IGC-UP, USGS y EMSC. By @elprotectorado">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Sismo PA">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
<link rel="preconnect" href="https://a.basemaps.cartocdn.com" crossorigin>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<link rel="stylesheet" href="/app.css">
<title>Sismo Panamá · ISTMO</title>
</head>
<body>
<div id="gate">
  <img class="logo" src="/icon-192.png" alt="">
  <h1>SISMO <b>PANAMÁ</b></h1>
  <p>Vigilancia sísmica en tiempo real con prioridad en Panamá: Instituto de Geociencias (IGC-UP), USGS y EMSC. Un toque activa pantalla completa, pantalla siempre encendida, alarmas con sonido, notificaciones y el detector de movimiento del equipo.</p>
  <button id="go">ACTIVAR VIGILANCIA</button>
  <div class="perms"><span>Pantalla completa</span><span>Sonido y voz</span><span>Notificaciones</span><span>Acelerómetro</span><span>Ubicación</span></div>
  <button class="btn sm" id="skip">Entrar sin permisos</button>
  <div class="by">ISTMO · BY @ELPROTECTORADO</div>
</div>

<div class="app" id="app">
  <nav id="nav" aria-label="Secciones"></nav>
  <div id="col">
    <header id="top">
      <div><div class="title">ISTMO · <b>SISMO PANAMÁ</b></div><span class="sub">IGC-UP · USGS · EMSC</span></div>
      <div id="leds"></div>
      <div id="clock"><b id="clk">--:--:--</b><span>HORA PANAMÁ</span></div>
      <button class="ibtn" id="bFs" aria-label="Pantalla completa"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      <button class="ibtn" id="bMute" aria-label="Sonido"><svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/></svg></button>
    </header>
    <div id="ribbon"><canvas id="rib"></canvas><span class="l" style="left:10px">últimas 24 h · sismograma del catálogo</span><span class="l" style="right:10px">ahora</span></div>
    <main id="views">
      <section class="view" id="v-radar">
        <div id="map"></div>
        <canvas id="mapfb" class="hide"></canvas>
        <div class="mapbar" id="mTop"></div>
        <div class="mapbar" id="mSide"></div>
        <div class="card" id="hero"></div>
        <div class="card" id="sheet"></div>
        <div class="card mapbar" id="mLegend"></div>
      </section>
      <section class="view" id="v-eventos"></section>
      <section class="view" id="v-replicas"></section>
      <section class="view" id="v-datos"></section>
      <section class="view" id="v-guia"></section>
      <section class="view" id="v-ajustes"></section>
    </main>
  </div>
</div>

<div id="alarm" role="alertdialog" aria-live="assertive" aria-label="Alerta sísmica"></div>
<div id="toasts" aria-live="polite"></div>
<div id="offline">Sin conexión · mostrando los últimos datos guardados</div>
<div id="dim"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" crossorigin="anonymous"></script>
<script src="/shared.js"></script>
<script src="/app.js"></script>
</body>
</html>
`;
const CSS = `/* ISTMO — tema "isosista": abismo oceánico + anillos isosísmicos + señal magma */
:root{
  --bg0:#030810;--bg1:#061320;--bg2:#0a1c2b;--bg3:#0f2638;
  --line:rgba(120,190,230,.14);--line2:rgba(120,190,230,.3);
  --tx:#e3f0f8;--mut:#86a0b3;--dim:#506a7e;
  --teal:#27f0c4;--cyan:#4fc3f7;--amber:#ffb020;--red:#ff4d6d;--mag:#ff2bd6;--gold:#ffd166;
  --glass:rgba(7,19,31,.78);--r:16px;--nav:76px;
  --sb:env(safe-area-inset-bottom,0px);--st:env(safe-area-inset-top,0px);--sl:env(safe-area-inset-left,0px);--sr:env(safe-area-inset-right,0px);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg0);color:var(--tx);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;overscroll-behavior:none;overflow:hidden}
body{background:radial-gradient(1200px 600px at 10% -10%,rgba(39,240,196,.10),transparent 60%),radial-gradient(900px 500px at 100% 0,rgba(255,77,109,.09),transparent 60%),var(--bg0)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:repeating-radial-gradient(circle at 88% 6%,transparent 0 46px,rgba(39,240,196,.05) 47px 48px)}
button,select,input{font:inherit;color:inherit}
button{cursor:pointer}
a{color:var(--cyan)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.cap{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut)}
.hide{display:none!important}

/* ---------- Arranque ---------- */
#gate{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:28px;text-align:center;overflow:auto;background:radial-gradient(900px 500px at 50% 25%,#0d3145 0,rgba(3,8,16,.97) 70%),var(--bg0)}
#gate .logo{width:112px;height:112px;border-radius:28px;box-shadow:0 0 60px rgba(39,240,196,.25)}
#gate h1{margin:0;font-size:clamp(30px,8vw,56px);letter-spacing:.14em;font-weight:800}
#gate h1 b{color:var(--teal)}
#gate p{margin:0;color:var(--mut);max-width:560px}
#go{border:0;color:#04121a;font-weight:800;font-size:clamp(18px,4.6vw,26px);letter-spacing:.06em;padding:20px 34px;border-radius:18px;background:linear-gradient(135deg,var(--teal),#7ff6dd);box-shadow:0 0 0 0 rgba(39,240,196,.55);animation:pulse 2.2s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 26px rgba(39,240,196,0)}100%{box-shadow:0 0 0 0 rgba(39,240,196,0)}}
#gate .perms{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:620px}
#gate .perms span{font-size:12px;padding:5px 10px;border:1px solid var(--line2);border-radius:999px;color:var(--mut)}
#gate .by{font-size:12px;color:var(--dim);letter-spacing:.12em}

/* ---------- Estructura ---------- */
.app{position:relative;z-index:1;display:grid;grid-template-columns:var(--nav) 1fr;height:100dvh;padding-left:var(--sl);padding-right:var(--sr)}
#col{display:flex;flex-direction:column;min-width:0;min-height:0}
#nav{order:-1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:calc(10px + var(--st)) 6px 10px;border-right:1px solid var(--line);background:linear-gradient(180deg,rgba(7,19,31,.95),rgba(4,10,18,.95))}
#nav .brand{width:46px;height:46px;border-radius:14px;margin-bottom:10px;box-shadow:0 0 24px rgba(39,240,196,.2)}
#nav button{position:relative;width:62px;padding:9px 0 7px;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:1px solid transparent;border-radius:14px;color:var(--mut);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
#nav button svg{width:23px;height:23px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#nav button.on{color:var(--teal);background:rgba(39,240,196,.08);border-color:rgba(39,240,196,.35);box-shadow:inset 0 0 18px rgba(39,240,196,.08)}
#nav button .dot{position:absolute;top:6px;right:12px;min-width:16px;height:16px;border-radius:8px;background:var(--red);color:#fff;font-size:10px;line-height:16px;font-weight:800;letter-spacing:0;padding:0 4px;text-align:center}
#top{display:flex;align-items:center;gap:12px;padding:calc(8px + var(--st)) 14px 8px;min-height:50px}
#top .title{font-weight:800;letter-spacing:.16em;font-size:15px}
#top .title b{color:var(--teal)}
#top .sub{font-size:10px;letter-spacing:.2em;color:var(--mut);display:block}
#leds{display:flex;gap:6px;flex-wrap:wrap;margin-left:6px}
.led{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.1em;padding:3px 8px;border:1px solid var(--line);border-radius:999px;color:var(--mut);text-transform:uppercase}
.led i{width:8px;height:8px;border-radius:50%;background:var(--dim)}
.led.ok i{background:var(--teal);box-shadow:0 0 8px var(--teal)}
.led.warn i{background:var(--amber);box-shadow:0 0 8px var(--amber)}
.led.bad i{background:var(--red);box-shadow:0 0 8px var(--red)}
#clock{margin-left:auto;text-align:right;line-height:1.1}
#clock b{font-family:var(--mono);font-size:18px;letter-spacing:.04em}
#clock span{display:block;font-size:10px;color:var(--mut);letter-spacing:.14em}
.ibtn{width:38px;height:38px;flex:none;border-radius:12px;background:rgba(15,38,56,.7);border:1px solid var(--line);display:grid;place-items:center;color:var(--tx)}
.ibtn svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ibtn:active{transform:scale(.94)}
.ibtn.off{color:var(--red)}
#ribbon{position:relative;height:62px;margin:0 12px 8px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:linear-gradient(180deg,rgba(10,28,43,.9),rgba(5,14,24,.9))}
#ribbon canvas{position:absolute;inset:0;width:100%;height:100%}
#ribbon .l{position:absolute;top:5px;font-size:9.5px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;pointer-events:none}
#views{position:relative;flex:1;min-height:0}
.view{display:none;position:absolute;inset:0;overflow:auto;padding:4px 12px 24px;-webkit-overflow-scrolling:touch}
.view.on{display:block}
#v-radar{padding:0;overflow:hidden}
.pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin:6px 2px 12px;flex-wrap:wrap}
.pagehead h2{margin:0;font-size:22px;letter-spacing:.06em}
.pagehead p{margin:2px 0 0;color:var(--mut);font-size:13px}
.wrap{max-width:1100px;margin:0 auto}

/* ---------- Componentes ---------- */
.card{background:var(--glass);border:1px solid var(--line);border-radius:var(--r);padding:14px;-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%)}
.wrap .card+.card{margin-top:12px}
.card h3{margin:0 0 10px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--teal);font-weight:700}
.grid{display:grid;gap:12px}
.grid>.card{margin-top:0!important}
.g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid var(--line2);background:rgba(15,38,56,.7);font-weight:600}
.btn:active{transform:scale(.97)}
.btn.pri{background:linear-gradient(135deg,var(--teal),#7ff6dd);color:#04121a;border-color:transparent}
.btn.dng{background:rgba(255,77,109,.14);border-color:rgba(255,77,109,.5);color:#ffb3c0}
.btn.sm{padding:6px 10px;font-size:13px;border-radius:10px}
.btn[disabled]{opacity:.45;pointer-events:none}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:12px;overflow:hidden;background:rgba(5,14,24,.7)}
.seg button{background:none;border:0;padding:7px 12px;color:var(--mut);font-size:13px;font-weight:600}
.seg button.on{background:rgba(39,240,196,.16);color:var(--teal)}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid var(--line2);color:var(--mut);background:rgba(5,14,24,.82)}
.chip.on{color:var(--teal);border-color:rgba(39,240,196,.5)}
button.chip{cursor:pointer}
.tag{font-size:10px;letter-spacing:.08em;padding:2px 7px;border-radius:6px;border:1px solid var(--line2);color:var(--mut);text-transform:uppercase;white-space:nowrap}
.tag.igc{color:var(--gold);border-color:rgba(255,209,102,.5)}
.tag.rev{color:var(--teal);border-color:rgba(39,240,196,.5)}
.tag.pre{color:var(--amber);border-color:rgba(255,176,32,.45)}
.tag.rep{color:var(--cyan);border-color:rgba(79,195,247,.5)}
.tag.main{color:var(--mag);border-color:rgba(255,43,214,.5)}
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .t{min-width:0}
.row .t b{display:block;font-weight:600}
.row .t small{display:block;color:var(--mut);font-size:12.5px;margin-top:1px}
.sw{position:relative;flex:none;width:48px;height:28px;border-radius:14px;background:#12293a;border:1px solid var(--line2);transition:.2s;padding:0}
.sw::after{content:"";position:absolute;left:3px;top:3px;width:20px;height:20px;border-radius:50%;background:#9fb6c7;transition:.2s}
.sw.on{background:rgba(39,240,196,.28);border-color:var(--teal)}
.sw.on::after{left:23px;background:var(--teal)}
select,input[type=text],input[type=tel],input[type=number]{background:#0b1b29;border:1px solid var(--line2);border-radius:10px;padding:8px 10px;max-width:56%}
input[type=range]{accent-color:var(--teal);width:150px}
.kpi{padding:12px 14px}
.kpi b{display:block;font:700 28px/1.1 var(--mono);letter-spacing:-.02em}
.kpi span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.kpi small{display:block;color:var(--mut);margin-top:3px;font-size:12px}
.mg{flex:none;min-width:54px;height:54px;display:grid;place-items:center;border-radius:14px;font:800 20px var(--mono);color:var(--c,#27f0c4);background:rgba(7,19,31,.9);border:1px solid var(--c,#27f0c4);box-shadow:0 0 16px rgba(39,240,196,.12)}
.ev{display:flex;gap:12px;align-items:center;padding:11px 8px;border-bottom:1px solid var(--line);cursor:pointer;border-radius:12px}
.ev:hover{background:rgba(39,240,196,.05)}
.ev:last-child{border-bottom:0}
.ev .b{min-width:0;flex:1}
.ev .b b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev .b small{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;color:var(--mut);font-size:12.5px;margin-top:3px}
.ev.sel{background:rgba(39,240,196,.09);outline:1px solid rgba(39,240,196,.35)}
.empty{padding:26px 10px;text-align:center;color:var(--mut)}
.bar{height:8px;border-radius:5px;background:#10263a;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--teal);transition:width .12s,background .2s}
canvas.ch{width:100%;display:block}
details.acc{border:1px solid var(--line);border-radius:14px;background:var(--glass);margin-top:10px}
details.acc summary{padding:14px;cursor:pointer;font-weight:700;letter-spacing:.04em;list-style:none;display:flex;justify-content:space-between;align-items:center}
details.acc summary::-webkit-details-marker{display:none}
details.acc summary::after{content:"+";color:var(--teal);font-size:22px;line-height:1}
details.acc[open] summary::after{content:"–"}
details.acc .in{padding:0 16px 14px;color:#b9cddb}
details.acc ul,details.acc ol{margin:6px 0;padding-left:20px}
details.acc li{margin:5px 0}
.chk{display:flex;gap:10px;align-items:center;padding:7px 0;cursor:pointer}
.chk i{flex:none;width:22px;height:22px;border-radius:7px;border:1.5px solid var(--line2);display:grid;place-items:center;color:transparent;font-style:normal;font-weight:800}
.chk.on i{background:var(--teal);border-color:var(--teal);color:#04121a}
.chk.on span{color:var(--mut);text-decoration:line-through}
.note{font-size:12.5px;color:var(--mut)}
.warnbox{border:1px solid rgba(255,176,32,.5);background:rgba(255,176,32,.08);border-radius:12px;padding:10px 12px;color:#ffe2b0;font-size:13px}

/* ---------- Radar / mapa ---------- */
#map{position:absolute;inset:0;background:#07121d}
.leaflet-container{background:#07121d;font:inherit}
.leaflet-control-zoom a{background:rgba(7,19,31,.92)!important;color:var(--tx)!important;border-color:var(--line2)!important}
.leaflet-control-attribution{background:rgba(3,8,16,.7)!important;color:var(--dim)!important;font-size:9px!important}
.leaflet-control-attribution a{color:var(--mut)!important}
.leaflet-tooltip{background:rgba(3,8,16,.94);color:var(--tx);border:1px solid var(--line2);border-radius:8px;box-shadow:none;font-size:12px}
#mapfb{position:absolute;inset:0;width:100%;height:100%}
.mapbar{position:absolute;z-index:500;display:flex;gap:6px;flex-wrap:wrap}
#mTop{left:12px;top:12px;right:64px}
#mSide{right:12px;top:12px;flex-direction:column}
#mLegend{left:12px;bottom:12px;z-index:400;padding:8px 10px;font-size:11px;gap:10px;align-items:center;width:auto;border-radius:12px;display:none}
@media (min-width:821px){#mLegend{display:flex}}
.pulse{position:relative;width:0;height:0}
.pulse i{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:2px solid var(--c,#ff4d6d);animation:ring 1.8s ease-out infinite;opacity:0}
.pulse i:nth-child(2){animation-delay:.6s}
@keyframes ring{0%{transform:scale(.2);opacity:.9}100%{transform:scale(1.8);opacity:0}}
.me{width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid var(--cyan);box-shadow:0 0 0 6px rgba(79,195,247,.25)}
#hero{position:absolute;z-index:450;left:12px;top:58px;width:min(372px,calc(100% - 24px));padding:14px}
#hero .top{display:flex;gap:14px;align-items:center}
#hero .gauge{flex:none;width:112px;height:76px}
#hero .tt{min-width:0}
#hero .tt .lv{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:800}
#hero .tt .pl{font-weight:600;margin:3px 0 2px;line-height:1.25}
#hero .tt small{color:var(--mut);font-size:12.5px}
#hero .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
#hero .stats div{padding:8px;border-radius:10px;background:rgba(5,14,24,.7);border:1px solid var(--line);text-align:center}
#hero .stats b{display:block;font:700 18px var(--mono)}
#hero .stats span{font-size:9.5px;letter-spacing:.12em;color:var(--mut);text-transform:uppercase}
#hero.l1{border-color:rgba(79,195,247,.55)}
#hero.l2{border-color:rgba(255,176,32,.7);box-shadow:0 0 30px rgba(255,176,32,.18)}
#hero.l3{border-color:rgba(255,77,109,.85);box-shadow:0 0 40px rgba(255,77,109,.3);animation:hz 1.4s infinite}
@keyframes hz{50%{box-shadow:0 0 60px rgba(255,77,109,.55)}}
#sheet{position:absolute;z-index:480;right:12px;top:58px;width:min(360px,calc(100% - 24px));max-height:calc(100% - 80px);overflow:auto;padding:16px;transform:translateX(120%);transition:transform .25s}
#sheet.on{transform:none}
#sheet .x{position:absolute;right:10px;top:10px}
#sheet dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:12px 0}
#sheet dt{color:var(--mut);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
#sheet dd{margin:0;font-weight:600}
#sheet .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}

/* ---------- Alarma ---------- */
#alarm{position:fixed;inset:0;z-index:80;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:calc(18px + var(--st)) 18px calc(18px + var(--sb));text-align:center;color:#fff;overflow:auto}
#alarm.on{display:flex}
#alarm.l3{background:radial-gradient(800px 500px at 50% 35%,#c4002b,#46000f);animation:fl3 .9s infinite}
#alarm.l2{background:radial-gradient(800px 500px at 50% 35%,#c97800,#4a2a00);animation:fl2 1.4s infinite}
#alarm.l1{background:radial-gradient(800px 500px at 50% 35%,#0b6f8a,#04202a)}
#alarm.post{animation:none!important;background:radial-gradient(800px 500px at 50% 35%,#0a5c4e,#031a17)}
@keyframes fl3{50%{filter:brightness(.55)}}
@keyframes fl2{50%{filter:brightness(.72)}}
#alarm .lvl{font-size:clamp(15px,3.6vw,22px);font-weight:800;letter-spacing:.3em}
#alarm .big{font:900 clamp(96px,30vw,240px)/0.95 var(--mono);text-shadow:0 0 50px rgba(255,255,255,.35)}
#alarm .pl{font-size:clamp(18px,4.4vw,30px);font-weight:700;max-width:900px}
#alarm .sub{font-size:clamp(14px,3.2vw,20px);opacity:.9}
#alarm .eta{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin:6px 0}
#alarm .eta div{min-width:130px;padding:10px 14px;border-radius:16px;background:rgba(0,0,0,.38);border:1px solid rgba(255,255,255,.25)}
#alarm .eta b{display:block;font:800 clamp(30px,8vw,52px)/1 var(--mono)}
#alarm .eta span{font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.85}
#alarm .tips{font-size:clamp(16px,3.8vw,24px);max-width:760px;font-weight:700;line-height:1.35}
#alarm .acts{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px}
#alarm .acts button{padding:14px 22px;font-size:17px;font-weight:800;border-radius:16px;border:2px solid rgba(255,255,255,.55);background:rgba(0,0,0,.35);color:#fff}
#alarm .acts button.ok{background:#fff;color:#7a0020;border-color:#fff}

/* ---------- Toasts / avisos ---------- */
#toasts{position:fixed;z-index:85;left:50%;transform:translateX(-50%);top:calc(10px + var(--st));display:flex;flex-direction:column;gap:8px;width:min(520px,calc(100% - 20px));pointer-events:none}
.toast{pointer-events:auto;display:flex;gap:10px;align-items:center;padding:11px 14px;border-radius:14px;background:rgba(7,19,31,.97);border:1px solid var(--line2);box-shadow:0 10px 40px rgba(0,0,0,.5);animation:tin .25s}
.toast.warn{border-color:rgba(255,176,32,.6)}
.toast.bad{border-color:rgba(255,77,109,.7)}
.toast.good{border-color:rgba(39,240,196,.6)}
.toast b{display:block}
.toast small{color:var(--mut)}
@keyframes tin{from{transform:translateY(-12px);opacity:0}}
#offline{position:fixed;z-index:84;left:0;right:0;bottom:calc(var(--sb) + 76px);margin:auto;width:max-content;max-width:92%;padding:7px 14px;border-radius:999px;background:rgba(255,176,32,.16);border:1px solid rgba(255,176,32,.6);color:#ffd9a0;font-size:12.5px;display:none}
#dim{position:fixed;inset:0;z-index:70;background:#000;opacity:0;pointer-events:none;transition:opacity .4s}
body.dim #dim{opacity:.62}
body.kiosk #nav,body.kiosk #ribbon{display:none}
body.kiosk .app{grid-template-columns:1fr}
body.kiosk #hero{left:50%;top:50%;transform:translate(-50%,-50%) scale(1.18);width:min(430px,92%)}
body.kiosk #mTop,body.kiosk #mSide{display:none}

/* ---------- Móvil ---------- */
@media (max-width:820px){
  .app{grid-template-columns:1fr;grid-template-rows:1fr auto}
  #nav{order:2;flex-direction:row;justify-content:space-around;gap:0;padding:6px 4px calc(6px + var(--sb));border-right:0;border-top:1px solid var(--line)}
  #nav .brand{display:none}
  #nav button{flex:1;width:auto;padding:7px 0 5px;font-size:9.5px;letter-spacing:.04em}
  #nav button .dot{right:calc(50% - 22px)}
  #leds{display:none}
  #top .sub{display:none}
  #hero{top:auto;bottom:12px;left:12px;width:calc(100% - 24px)}
  #hero .gauge{width:92px;height:62px}
  #hero .stats{margin-top:10px}
  #sheet{top:auto;bottom:0;right:0;left:0;width:100%;max-height:72%;border-radius:20px 20px 0 0;transform:translateY(110%)}
  #sheet.on{transform:none}
  #mTop{right:64px}
  body.kiosk .app{grid-template-rows:1fr}
  body.kiosk #hero{transform:translate(-50%,-50%) scale(1.05)}
  #offline{bottom:calc(var(--sb) + 70px)}
}
@media (max-width:820px) and (max-height:620px){#ribbon{display:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
const APPJS = `'use strict';
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
  persist: true, wake: true, kiosk: false, dim: false, map: 'dark', range: '24h', minMag: 0, onlyPan: true,
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
    body = 'id,hora_utc,hora_panama,magnitud,profundidad_km,latitud,longitud,lugar,estado,fuentes,rol\\n' + list.map((q) => [q.id, new Date(q.t).toISOString(), '"' + when(q.t) + '"', q.mag.toFixed(1), Math.round(q.depth || 0), q.lat.toFixed(4), q.lon.toFixed(4), '"' + String(q.place).replace(/"/g, '""') + '"', q.st === 'R' ? 'revisado' : 'preliminar', (q.src || []).join('+'), q.role].join(',')).join('\\n');
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
  const places = {}; pan.forEach((q) => { const k = placeShort(q.place).replace(/^\\d+\\s*km\\s+(?:al\\s+|a\\s+el\\s+)?\\w+\\s+de\\s+/i, ''); places[k] = (places[k] || 0) + 1; });
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
  $('#ctAdd').addEventListener('click', () => { const n = $('#ctN').value.trim(), t = $('#ctT').value.trim(); if (!n || !/[\\d]{4,}/.test(t)) { toast('Escribe nombre y teléfono válido', '', 'warn'); return; } const c = LS.get('contacts', []); c.push({ n, tel: t.replace(/[^\\d+]/g, '') }); LS.set('contacts', c.slice(0, 12)); $('#ctN').value = ''; $('#ctT').value = ''; drawCt(); });
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
`;
const SWJS = `/* ISTMO · Service Worker — caché offline, Web Push, notificaciones con acciones, sincronización periódica */
importScripts('/shared.js');
const V = '2.0.mv3bz80s';
const SHELL = 'istmo-shell-' + V, TILES = 'istmo-tiles', DATA = 'istmo-data', META = 'sismo-meta';
const PRE = ['/', '/app.css', '/app.js', '/shared.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];
const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.allSettled(PRE.map((u) => c.add(u)).concat(CDN.map((u) => c.add(new Request(u, { mode: 'cors' })))));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter((k) => k.startsWith('istmo-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (_) { } }
    await self.clients.claim();
  })());
});
async function trim(name, max) { const c = await caches.open(name), ks = await c.keys(); for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]); }
self.addEventListener('fetch', (e) => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.pathname.startsWith('/api/push')) return;
  if (u.origin === location.origin && u.pathname.startsWith('/api/')) { // datos: red primero, caché de respaldo
    e.respondWith(fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(DATA).then((c) => c.put(r, cp)); } return res; }).catch(() => caches.match(r).then((h) => h || new Response('{"error":"offline","quakes":[]}', { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  if (/basemaps\\.cartocdn\\.com|tile\\.openstreetmap\\.org|tile\\.opentopomap\\.org|arcgisonline\\.com/.test(u.hostname)) { // teselas: caché primero
    e.respondWith(caches.open(TILES).then(async (c) => { const h = await c.match(r); if (h) return h; try { const res = await fetch(r); if (res.ok || res.type === 'opaque') { c.put(r, res.clone()); trim(TILES, 400); } return res; } catch (err) { return h || Response.error(); } }));
    return;
  }
  if (u.origin === location.origin || u.hostname === 'cdnjs.cloudflare.com') { // app: caché primero, actualiza en segundo plano
    e.respondWith((async () => {
      const hit = await caches.match(r, { ignoreSearch: r.mode === 'navigate' });
      const net = fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(SHELL).then((c) => c.put(r.mode === 'navigate' ? '/' : r, cp)); } return res; }).catch(() => null);
      return hit || (await net) || (await caches.match('/')) || Response.error();
    })());
  }
});

/* ---------- Push (llega aunque la app esté cerrada) ---------- */
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Sismo', body: e.data ? e.data.text() : '' }; }
  const lvl = d.lvl || 1;
  const opts = {
    body: d.body || '', tag: d.tag || ('q-' + (d.id || Date.now())), icon: '/icon-192.png', badge: '/icon-192.png', lang: 'es', timestamp: d.t || Date.now(),
    renotify: true, requireInteraction: lvl >= 2, vibrate: lvl >= 3 ? [600, 150, 600, 150, 900, 150, 900] : lvl === 2 ? [400, 120, 400, 120, 600] : [200, 100, 200],
    data: { id: d.id, url: d.id && d.id !== 'test' ? '/?q=' + encodeURIComponent(d.id) : '/', lvl },
    actions: d.kind === 'test' ? [] : [{ action: 'map', title: 'Ver en el mapa' }, { action: 'close', title: 'Cerrar' }]
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Sismo', opts);
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach((c) => c.postMessage({ type: 'push', data: d }));
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'close') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { try { await c.focus(); c.postMessage({ type: 'open', url }); return; } catch (_) { } } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'resub' }))));
});

/* ---------- Mensajes desde la página (notificación persistente de vigilancia) ---------- */
self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'skip') self.skipWaiting();
});

/* ---------- Sincronización periódica (Chrome/Android con la PWA instalada) ---------- */
self.addEventListener('periodicsync', (e) => { if (e.tag === 'quake-check') e.waitUntil(bgCheck()); });
async function bgCheck() {
  try {
    const mc = await caches.open(META);
    let cfg = {}, seen = {}; try { cfg = await (await mc.match('/cfg')).json(); } catch (_) { }
    try { seen = await (await mc.match('/seen')).json(); } catch (_) { }
    const u = { lat: cfg.lat || 8.98, lon: cfg.lon || -79.52 };
    const j = await (await fetch('/api/quakes?days=1')).json(), now = Date.now();
    for (const q of j.quakes || []) {
      const lvl = levelFor(q, u);
      if (now - q.t > 3600e3 || seen[q.id] || !(lvl >= 2 || (cfg.m1 && inBox(q, PAN) && q.mag >= cfg.m1))) continue;
      seen[q.id] = 1;
      await self.registration.showNotification((lvl === 3 ? '🔴 SISMO FUERTE · M' : lvl === 2 ? '🟠 ALERTA · M' : '🔵 Sismo M') + q.mag.toFixed(1), {
        body: q.place + ' · prof. ' + Math.round(q.depth) + ' km · a ' + Math.round(kmDist(u, q)) + ' km de ti', tag: 'q-' + q.id, icon: '/icon-192.png', badge: '/icon-192.png',
        requireInteraction: lvl >= 2, renotify: true, vibrate: [400, 120, 400, 120, 700], lang: 'es', data: { id: q.id, url: '/?q=' + encodeURIComponent(q.id), lvl }
      });
    }
    await mc.put('/seen', new Response(JSON.stringify(seen)));
  } catch (_) { }
}
`;
const DOCS = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API · Sismo Panamá ISTMO</title>
<link rel="icon" href="/icon.svg">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#040a12;color:#dbe8f2;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:0 0 60px}
header{padding:34px 20px 22px;border-bottom:1px solid #12293a;background:radial-gradient(900px 300px at 20% -20%,#0f3a4d 0,transparent 70%)}
h1{margin:0;font-size:clamp(26px,6vw,40px);letter-spacing:.04em}
h1 b{color:#27f0c4}
h2{margin:34px 0 10px;font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#27f0c4}
main{max-width:920px;margin:0 auto;padding:0 18px}
p,li{color:#9db3c4}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:#0b1b29;border:1px solid #12293a;padding:1px 6px;border-radius:6px;color:#ffd166;font-size:.92em}
pre{background:#071420;border:1px solid #12293a;border-radius:12px;padding:14px;overflow:auto;color:#cfe8f7}
.ep{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;background:#071420;border:1px solid #12293a;border-radius:14px;padding:14px;margin:10px 0}
.ep .m{color:#27f0c4;font-weight:700}
a{color:#4fc3f7}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #12293a;padding:8px 6px;text-align:left;vertical-align:top}
th{color:#7d93a5;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border:1px solid #1d4a5e;border-radius:999px;color:#7fe3ff}
</style></head><body>
<header><main><h1>SISMO PANAMÁ · <b>API</b></h1>
<p>Datos sísmicos abiertos para Panamá: el listado del <b>Instituto de Geociencias (IGC-UP)</b> convertido a JSON/GeoJSON, fusionado con <b>USGS</b> y <b>EMSC</b>, con detección de réplicas. Sin clave, con CORS abierto. <br><a href="/">← Volver a la app</a> · By <b>@elprotectorado</b></p></main></header>
<main>
<h2>Endpoints</h2>
<div class="ep"><span class="m">GET</span><span><code>/api/quakes</code> — todos los sismos fusionados (IGC + USGS + EMSC), con <code>role</code> (main / after / fore / single), <code>nrep</code> y magnitudes por fuente.</span>
<span class="m">GET</span><span><code>/api/quakes.geojson</code> — igual, en GeoJSON.</span>
<span class="m">GET</span><span><code>/api/igc</code> · <code>/api/igc.geojson</code> — <span class="tag">conversión del listado oficial</span> de <code>sismosgeociencias.up.ac.pa</code> (últimos 7 días, con estado PRELIMINAR / REVISADO).</span>
<span class="m">GET</span><span><code>/api/latest</code> — último sismo en Panamá y el más fuerte de 24 h.</span>
<span class="m">GET</span><span><code>/api/sequences</code> — secuencias sísmicas: réplicas y probabilidad estimada de réplicas (Reasenberg &amp; Jones, parámetros genéricos).</span>
<span class="m">GET</span><span><code>/api/stats</code> — conteos por día, por magnitud, valor b de Gutenberg-Richter, energía liberada.</span>
<span class="m">GET</span><span><code>/api/status</code> — salud de cada fuente (latencia, errores, datos obsoletos) y estado del push.</span></div>
<h2>Parámetros de filtro (quakes / igc)</h2>
<table>
<tr><th>Parámetro</th><th>Descripción</th></tr>
<tr><td><code>min</code>, <code>max</code></td><td>Magnitud mínima / máxima</td></tr>
<tr><td><code>days</code></td><td>Solo los últimos N días (máx. 8)</td></tr>
<tr><td><code>since</code></td><td>Marca de tiempo (ms) o fecha ISO</td></tr>
<tr><td><code>region=pan</code></td><td>Solo dentro del recuadro de Panamá (4.5–10.5°N, 84–76.5°O)</td></tr>
<tr><td><code>src=IGC|USGS|EMSC</code></td><td>Eventos confirmados por esa fuente</td></tr>
<tr><td><code>st=R</code></td><td>Solo revisados (IGC) / revisados (USGS)</td></tr>
<tr><td><code>role=after|main|fore|single</code></td><td>Filtra por rol en la secuencia</td></tr>
<tr><td><code>limit</code>, <code>fresh=1</code></td><td>Límite de filas · ignora la caché de 15 s</td></tr>
</table>
<h2>Ejemplos</h2>
<pre>curl "/api/igc?min=3&amp;days=2"
curl "/api/quakes.geojson?region=pan&amp;min=4"
curl "/api/sequences"
fetch('/api/latest').then(r =&gt; r.json()).then(console.log)</pre>
<h2>Notas de calidad</h2>
<ul>
<li>El listado del IGC se lee y se normaliza en cada consulta (caché 15 s). Las horas locales (UTC−5) se convierten a UTC. Si el sitio del IGC no responde, la API usa el último dato bueno (hasta 30 min) y lo marca <code>stale</code> en <code>/api/status</code>.</li>
<li>Cuando varias redes reportan el mismo sismo (±100 s y &lt;120 km) se fusionan; la magnitud principal es la del IGC si existe, luego USGS, luego EMSC. El resto queda en <code>mags</code>.</li>
<li>Información de apoyo, <b>no oficial</b>. Para decisiones de seguridad consulta al IGC-UP y SINAPROC. Emergencias: 911.</li>
</ul>
<h2>Activar alertas con la app cerrada (Web Push)</h2>
<ol>
<li>Workers → tu Worker → <b>Settings → Bindings → Add → KV namespace</b>. Variable: <code>SISMO_KV</code> (crea un namespace nuevo).</li>
<li><b>Settings → Triggers → Cron Triggers → Add</b>: <code>* * * * *</code> (cada minuto).</li>
<li>Opcional: variable <code>VAPID_SUBJECT</code> (por ejemplo <code>mailto:tu@correo.com</code>) y <code>PUSH_BUDGET</code> (envíos por minuto; 40 en plan gratuito).</li>
<li>Abre la app → Ajustes → <b>Alertas push</b> → Activar. Las claves VAPID se generan solas la primera vez.</li>
</ol>
<p style="margin-top:30px;font-size:13px">Fuentes: IGC-UP · USGS Earthquake Hazards Program · EMSC-CSEM. Código por <b>@elprotectorado</b>.</p>
</main></body></html>
`;
const SHAREDJS = `/* ========= NÚCLEO COMPARTIDO (servidor + página + service worker) ========= */
const PAN = { minlat: 4.5, maxlat: 10.5, minlon: -84.0, maxlon: -76.5 };   // Panamá, Zona de Fractura, Darién
const REG = { minlat: -2.0, maxlat: 16.0, minlon: -93.0, maxlon: -68.0 };  // Centroamérica + norte de Sudamérica
const VP = 6.0, VS = 3.5; // km/s: velocidad típica onda P y S en corteza

const CITIES = [
  ['pty', 'Ciudad de Panamá', 8.98, -79.52], ['sanm', 'San Miguelito', 9.03, -79.50], ['colon', 'Colón', 9.36, -79.90],
  ['david', 'David (Chiriquí)', 8.43, -82.43], ['santiago', 'Santiago (Veraguas)', 8.10, -80.98], ['chitre', 'Chitré (Herrera)', 7.96, -80.43],
  ['lstos', 'Las Tablas (Los Santos)', 7.77, -80.28], ['penonome', 'Penonomé (Coclé)', 8.52, -80.36], ['chorrera', 'La Chorrera', 8.88, -79.78],
  ['bocas', 'Bocas del Toro', 9.34, -82.24], ['puertoarm', 'Puerto Armuelles', 8.28, -82.87], ['volcan', 'Volcán (Chiriquí)', 8.77, -82.63],
  ['yaviza', 'Darién (Yaviza)', 8.16, -77.69], ['guna', 'Guna Yala (El Porvenir)', 9.56, -78.96], ['sona', 'Soná', 8.00, -81.31],
  ['tonosi', 'Tonosí', 7.41, -80.44], ['changui', 'Changuinola', 9.43, -82.52]
];

function rad(d) { return d * Math.PI / 180; }
function kmDist(a, b) {
  const dl = rad(b.lat - a.lat), dn = rad(b.lon - a.lon);
  const x = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) * Math.sin(dn / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(x)));
}
function inBox(p, b) { return p.lat >= b.minlat && p.lat <= b.maxlat && p.lon >= b.minlon && p.lon <= b.maxlon; }

/* Nivel de alerta para un usuario en \`u\`: 0 nada · 1 informativo · 2 alerta · 3 peligro */
function levelFor(q, u) {
  if (q.local) return 2;
  const d = kmDist(u, q), p = inBox(q, PAN), m = q.mag;
  if ((m >= 6 && d < 700) || (p && m >= 5 && d < 350)) return 3;
  if ((p && m >= 4) || (m >= 5.5 && d < 1200) || (m >= 5 && d < 300)) return 2;
  if ((p && m >= 2.5) || (m >= 4.5 && d < 800)) return 1;
  return 0;
}
/* ¿Dos reportes (redes distintas) son el mismo sismo? */
function sameEvent(a, b) { return Math.abs(a.t - b.t) < 100000 && kmDist(a, b) < 120; }

/* Ventanas de secuencia: distancia de Gardner-Knopoff (1974); tiempo acotado a uso práctico */
function gkDist(M) { return Math.pow(10, 0.1238 * M + 0.983); }
function seqDays(M) { return Math.pow(10, 0.35 * M - 1.1); }

/* Clasifica cada evento: 'main' (con réplicas), 'after' (réplica), 'fore' (posible premonitor), 'single'. Muta y devuelve Q. */
function annotate(Q) {
  const asc = Q.slice().sort((a, b) => a.t - b.t), mains = [], byId = {};
  for (const e of asc) { e.role = 'single'; e.main = null; e.nrep = 0; e.nfore = 0; byId[e.id] = e; }
  for (const e of asc) {
    let best = null;
    for (const m of mains) {
      if (m.mag <= e.mag) continue;
      const dt = (e.t - m.t) / 864e5;
      if (dt < 0 || dt > seqDays(m.mag)) continue;
      if (kmDist(m, e) > gkDist(m.mag)) continue;
      if (!best || m.mag > best.mag) best = m;
    }
    if (best) { e.role = 'after'; e.main = best.id; best.nrep++; best.role = 'main'; }
    else if (e.mag >= 4) mains.push(e);
  }
  for (const m of mains) {
    if (m.mag < 4.5) continue;
    for (const f of asc) {
      if (f.t >= m.t) break;
      if (f.role !== 'single' || f.mag >= m.mag) continue;
      if ((m.t - f.t) / 864e5 > 2 || kmDist(m, f) > gkDist(m.mag)) continue;
      f.role = 'fore'; f.main = m.id; m.nfore++;
    }
    if (m.nfore > 0 && m.role === 'single') m.role = 'main';
  }
  return Q;
}

/* Probabilidad de al menos una réplica ≥ Mth en las próximas \`span\` días (Reasenberg & Jones 1989, parámetros genéricos).
   ageDays = tiempo desde el sismo principal. Es una ESTIMACIÓN no calibrada para Panamá. */
function aftershockProb(Mm, ageDays, Mth, span) {
  const a = -1.67, b = 0.91, p = 1.08, c = 0.05, t1 = Math.max(ageDays, 0.002), t2 = t1 + (span || 1);
  const I = (Math.pow(t2 + c, 1 - p) - Math.pow(t1 + c, 1 - p)) / (1 - p);
  return 1 - Math.exp(-Math.pow(10, a + b * (Mm - Mth)) * I);
}
function energyJ(M) { return Math.pow(10, 1.5 * M + 4.8); }
/* Radio aproximado (km) donde un sismo suele ser sentido — heurística */
function feltKm(M) { return Math.pow(10, 0.45 * M - 0.1); }
`;

const MANIFEST = JSON.stringify({
  id: '/', name: 'Sismo Panamá · ISTMO', short_name: 'Sismo PA', description: 'Vigilancia sísmica en tiempo real con prioridad en Panamá: IGC-UP, USGS y EMSC. By @elprotectorado',
  start_url: '/?src=pwa', scope: '/', display: 'fullscreen', display_override: ['fullscreen', 'standalone', 'minimal-ui'], orientation: 'any',
  background_color: '#040a12', theme_color: '#040a12', lang: 'es-PA', dir: 'ltr', categories: ['utilities', 'weather', 'news'],
  launch_handler: { client_mode: 'focus-existing' },
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
  ],
  shortcuts: [
    { name: 'Radar y mapa', short_name: 'Radar', url: '/?tab=radar', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    { name: 'Eventos recientes', short_name: 'Eventos', url: '/?tab=eventos', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    { name: 'Réplicas', short_name: 'Réplicas', url: '/?tab=replicas', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    { name: 'Guía de preparación', short_name: 'Guía', url: '/?tab=guia', icons: [{ src: '/icon-192.png', sizes: '192x192' }] }
  ]
});

const PAGE_HEADERS = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'accelerometer=(self), gyroscope=(self), geolocation=(self), fullscreen=(self), notifications=(self), vibrate=(self), screen-wake-lock=(self)' };

/* ---------------- Enrutador ---------------- */
async function handleApi(req, env, url) {
  const p = url.pathname, sp = url.searchParams;
  if (p === '/api' || p === '/api/' || p === '/docs') return text(DOCS, 'text/html; charset=utf-8', PAGE_HEADERS);
  if (p === '/api/quakes' || p === '/api/quakes.geojson') {
    const b = await getBase(sp.get('fresh') === '1'), list = filterQuakes(b.quakes, sp);
    if (p.endsWith('.geojson') || sp.get('format') === 'geojson') return json(toGeoJSON(list, { metadata: { updated: b.updated, count: list.length } }), 200, { 'content-type': 'application/geo+json; charset=utf-8' });
    return json({ updated: b.updated, took: b.took, version: b.version, sources: b.sources, count: list.length, quakes: list });
  }
  if (p === '/api/igc' || p === '/api/igc.geojson') {
    const b = await getBase(sp.get('fresh') === '1'), list = filterQuakes(b.quakes.filter((q) => q.src.indexOf('IGC') >= 0), sp)
      .map((q) => Object.assign({}, q, { mag: q.mags.IGC != null ? q.mags.IGC : q.mag }));
    if (p.endsWith('.geojson') || sp.get('format') === 'geojson') return json(toGeoJSON(list, { metadata: { source: 'IGC-UP', origin: IGC_URL, updated: b.updated, count: list.length } }), 200, { 'content-type': 'application/geo+json; charset=utf-8' });
    return json({ source: 'IGC-UP', origin: IGC_URL, status: b.sources.IGC, updated: b.updated, count: list.length, quakes: list });
  }
  if (p === '/api/latest') {
    const b = await getBase(), pan = b.quakes.filter((q) => inBox(q, PAN)), now = Date.now();
    const strongest = pan.filter((q) => now - q.t < 864e5).reduce((m, q) => (!m || q.mag > m.mag ? q : m), null);
    return json({ updated: b.updated, latest: pan[0] || null, strongest_24h: strongest });
  }
  if (p === '/api/stats') { const b = await getBase(); return json(Object.assign({ updated: b.updated }, statsOf(b.quakes))); }
  if (p === '/api/sequences') { const b = await getBase(); return json({ updated: b.updated, sequences: sequencesOf(b.quakes) }); }
  if (p === '/api/status') {
    const b = await getBase(sp.get('fresh') === '1');
    let subs = null; if (env.SISMO_KV) { try { subs = (await listSubs(env)).length; } catch (e) { subs = -1; } }
    return json({ ok: true, version: VERSION, time: Date.now(), updated: b.updated, took_ms: b.took, events: b.quakes.length, sources: b.sources, push: { kv: !!env.SISMO_KV, subscribers: subs, note: env.SISMO_KV ? 'Añade un Cron Trigger "* * * * *" para enviar alertas con la app cerrada' : 'Para alertas con la app cerrada enlaza un KV con el nombre SISMO_KV y un Cron Trigger' } }, 200, { 'cache-control': 'no-store' });
  }
  if (p === '/api/push/key') {
    if (!env.SISMO_KV) return json({ ok: false, reason: 'kv' }, 200, { 'cache-control': 'no-store' });
    return json({ ok: true, key: (await getVapid(env)).pub }, 200, { 'cache-control': 'no-store' });
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    if (!env.SISMO_KV) return json({ ok: false, reason: 'kv' }, 503);
    let b; try { b = await req.json(); } catch (e) { return json({ ok: false, reason: 'json' }, 400); }
    const s = b && b.sub, k = s && s.keys, pr = (b && b.prefs) || {};
    if (!s || !okPushHost(s.endpoint) || !k || !k.p256dh || !k.auth) return json({ ok: false, reason: 'suscripción inválida' }, 400);
    const meta = { e: s.endpoint, p: k.p256dh, a: k.auth, m1: Math.min(7, Math.max(1, +pr.m1 || 3.5)), m2: Math.min(8, Math.max(3, +pr.m2 || 5)), la: Math.round((+pr.la || 8.98) * 1e4) / 1e4, lo: Math.round((+pr.lo || -79.52) * 1e4) / 1e4, r: pr.r ? 1 : 0, c: Date.now() };
    if (JSON.stringify(meta).length > 1000) return json({ ok: false, reason: 'demasiado grande' }, 413);
    await env.SISMO_KV.put('s:' + await sha1hex(s.endpoint), '1', { metadata: meta, expirationTtl: 60 * 86400 });
    return json({ ok: true }, 200, { 'cache-control': 'no-store' });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    if (!env.SISMO_KV) return json({ ok: false }, 503);
    let b; try { b = await req.json(); } catch (e) { return json({ ok: false }, 400); }
    if (b && b.endpoint) await env.SISMO_KV.delete('s:' + await sha1hex(b.endpoint));
    return json({ ok: true }, 200, { 'cache-control': 'no-store' });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    if (!env.SISMO_KV) return json({ ok: false, reason: 'kv' }, 503);
    let b; try { b = await req.json(); } catch (e) { return json({ ok: false }, 400); }
    const s = b && b.sub, k = s && s.keys; if (!s || !okPushHost(s.endpoint) || !k) return json({ ok: false, reason: 'suscripción inválida' }, 400);
    try {
      const code = await sendPush(env, { e: s.endpoint, p: k.p256dh, a: k.auth }, { title: '✅ Prueba de alertas', body: 'Si ves esto con la app cerrada, las alertas push funcionan.', id: 'test', tag: 'test', lvl: 1, kind: 'test' }, 'normal');
      return json({ ok: code >= 200 && code < 300, status: code }, 200, { 'cache-control': 'no-store' });
    } catch (e) { return json({ ok: false, reason: String(e && e.message || e) }, 200); }
  }
  return json({ error: 'No encontrado', docs: '/api' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (p === '/' || p === '/index.html') return text(HTML, 'text/html; charset=utf-8', PAGE_HEADERS);
      if (p === '/app.css') return text(CSS, 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      if (p === '/app.js') return text(APPJS, 'application/javascript; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      if (p === '/shared.js') return text(SHAREDJS, 'application/javascript; charset=utf-8', { 'cache-control': 'public, max-age=300' });
      if (p === '/sw.js') return text(SWJS, 'application/javascript; charset=utf-8', { 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
      if (p === '/manifest.webmanifest') return text(MANIFEST, 'application/manifest+json; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
      if (p === '/icon.svg') return text(ICON_SVG, 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
      if (p === '/icon-192.png' || p === '/apple-touch-icon.png') return new Response(await iconPNG(192), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
      if (p === '/icon-512.png') return new Response(await iconPNG(512), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
      if (p === '/health') return text('ok', 'text/plain');
      if (p === '/api' || p.startsWith('/api/') || p === '/docs') return await handleApi(req, env, url);
      return new Response('No encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      return json({ error: 'Error interno', detail: String(err && err.message || err) }, 500, { 'cache-control': 'no-store' });
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runPushJob(env).catch(() => { })); }
};
