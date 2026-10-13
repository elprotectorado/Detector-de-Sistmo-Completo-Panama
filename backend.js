/* =====================================================================
   SISMO PANAMÁ · ISTMO — Cloudflare Worker (app + API + PWA + Web Push)
   By @elprotectorado
   Fuentes (todas abiertas, sin clave): IGC-UP (Univ. de Panamá) · USGS · EMSC · GEOFON · PTWC (tsunami)
   Opcional para alertas con la app CERRADA: KV binding "SISMO_KV" + Cron "* * * * *"
   ===================================================================== */

__SHARED__

const VERSION = '__VERSION__';
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
async function getText(url, ms, accept) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: accept || 'text/plain,*/*' }, cf: { cacheTtl: 15, cacheEverything: true }, signal: AbortSignal.timeout(ms || 9000) });
  if (r.status === 204) return '';
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
/* GEOFON (GFZ Potsdam) — FDSN abierto, sin clave. Formato texto: #EventID|Time|Lat|Lon|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType */
function geofonURL(b, minmag, days) {
  return 'https://geofon.gfz-potsdam.de/fdsnws/event/1/query?format=text&orderby=time&limit=400' +
    '&minlatitude=' + b.minlat + '&maxlatitude=' + b.maxlat + '&minlongitude=' + b.minlon + '&maxlongitude=' + b.maxlon +
    '&minmagnitude=' + minmag + '&starttime=' + iso(Date.now() - days * 864e5);
}
function parseGEOFON(txt) {
  const out = [];
  String(txt || '').split(/\r?\n/).forEach((ln) => {
    if (!ln || ln[0] === '#') return;
    const f = ln.split('|'); if (f.length < 11) return;
    const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(f[1]) ? f[1] : f[1] + 'Z'), lat = +f[2], lon = +f[3], depth = Math.abs(+f[4] || 0), mag = +f[10];
    if (!isFinite(t) || !isFinite(lat) || !isFinite(lon) || !isFinite(mag)) return;
    if (f[13] && !/earthquake/i.test(f[13])) return;
    out.push({ id: 'G' + f[0], src: 'GEOFON', t, lat, lon, depth, mag, place: (f[12] || 'Sin nombre').trim(), st: 'P', url: 'https://geofon.gfz-potsdam.de/eqinfo/event.php?id=' + encodeURIComponent(f[0]) });
  });
  return out;
}
/* Avisos del Pacific Tsunami Warning Center (tsunami.gov, Atom abierto). Solo informativo. */
const PTWC_URL = 'https://www.tsunami.gov/events/xml/PHEBAtom.xml';
function parsePTWC(xml) {
  const out = [], re = /<entry[\s>][\s\S]*?<\/entry>/gi; let m;
  while ((m = re.exec(xml)) && out.length < 12) {
    const e = m[0], g = (tag) => { const x = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(e); return x ? decodeEntities(x[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''; };
    const title = g('title'), sum = g('summary') || g('content'), t = Date.parse(g('updated') || g('published')), lk = /<link[^>]*href="([^"]+)"/i.exec(e), blob = (title + ' ' + sum);
    let level = 0; if (/warning/i.test(blob)) level = 3; else if (/watch|advisory/i.test(blob)) level = 2; else if (/threat/i.test(blob)) level = 1; if (/no tsunami threat|no hay amenaza/i.test(blob)) level = 0;
    out.push({ title, summary: sum.slice(0, 600), t: isFinite(t) ? t : null, url: lk ? lk[1] : 'https://www.tsunami.gov/', level, panama: /panam|costa rica|colombia|central america|caribbean/i.test(blob) });
  }
  return out;
}
async function getTsunami() {
  const now = Date.now(); if (MEM.tsu && now - MEM.tsuAt < 120000) return MEM.tsu;
  try { const msgs = parsePTWC(await getText(PTWC_URL, 8000, 'application/atom+xml,application/xml,text/xml,*/*')); MEM.tsu = { ok: true, source: 'PTWC · tsunami.gov', updated: now, messages: msgs }; }
  catch (e) { MEM.tsu = { ok: false, source: 'PTWC · tsunami.gov', updated: now, error: String(e && e.message || e), messages: (MEM.tsu && MEM.tsu.messages) || [] }; }
  MEM.tsuAt = now; return MEM.tsu;
}
async function fetchIGC() {
  const r = await fetch(IGC_URL, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, cf: { cacheTtl: 15, cacheEverything: true }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const list = parseIGC(await r.text());
  if (!list.length) throw new Error('El listado no contiene sismos legibles (¿cambió el formato?)');
  return list;
}

/* ---------------- Fusión multi-fuente ---------------- */
const PRIO = { IGC: 0, USGS: 1, EMSC: 2, GEOFON: 3 };
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
const MEM = { tsu: null, tsuAt: 0, base: null, at: 0, inflight: null, good: {}, icons: {}, vapid: null };
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
  const [igc, usgs, emsc, geo] = await Promise.all([
    timed('IGC', [fetchIGC()]),
    timed('USGS', [getJSON(usgsURL(PAN, 1, 7)).then(normUSGS), getJSON(usgsURL(REG, 4.5, 4)).then(normUSGS)]),
    timed('EMSC', [getJSON(emscURL(PAN, 1.5, 7)).then(normEMSC), getJSON(emscURL(REG, 4.5, 4)).then(normEMSC)]),
    timed('GEOFON', [getText(geofonURL(PAN, 2, 7)).then(parseGEOFON), getText(geofonURL(REG, 4.5, 4)).then(parseGEOFON)])
  ]);
  const cutoff = Date.now() - 8 * 864e5;
  const all = [].concat(igc.data, usgs.data, emsc.data, geo.data).filter((q) => q.t > cutoff && inBox(q, REG));
  const quakes = annotate(merge(all));
  const sources = {};
  [igc, usgs, emsc, geo].forEach((s) => { sources[s.name] = { ok: s.ok, stale: s.stale, n: s.n, ms: s.ms, err: s.err, at: s.at }; });
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
const HTML = `__HTML__`;
const CSS = `__CSS__`;
const APPJS = `__APPJS__`;
const SWJS = `__SW__`;
const DOCS = `__DOCS__`;
const SHAREDJS = __SHARED_STR__;

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
  if (p === '/api/tsunami') return json(await getTsunami(), 200, { 'cache-control': 'public, max-age=60' });
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
