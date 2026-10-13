// Genera src/app-0-geo.js: geometría vectorial (dominio público, Natural Earth) recortada a la región.
import fs from 'fs';
import { feature } from 'topojson-client';
const BB = [-93.5, -3, -67.5, 16.5]; // minx,miny,maxx,maxy
const topo = JSON.parse(fs.readFileSync('node_modules/world-atlas/countries-10m.json', 'utf8'));
const countries = feature(topo, topo.objects.countries).features;
const a1 = JSON.parse(fs.readFileSync('a1.geojson', 'utf8')).features;

function clip(ring) { // Sutherland–Hodgman contra el rectángulo
  let pts = ring.slice(0, -1);
  const edges = [[0, (p) => p[0] >= BB[0], (a, b) => [BB[0], a[1] + (b[1] - a[1]) * (BB[0] - a[0]) / (b[0] - a[0])]],
    [1, (p) => p[0] <= BB[2], (a, b) => [BB[2], a[1] + (b[1] - a[1]) * (BB[2] - a[0]) / (b[0] - a[0])]],
    [2, (p) => p[1] >= BB[1], (a, b) => [a[0] + (b[0] - a[0]) * (BB[1] - a[1]) / (b[1] - a[1]), BB[1]]],
    [3, (p) => p[1] <= BB[3], (a, b) => [a[0] + (b[0] - a[0]) * (BB[3] - a[1]) / (b[1] - a[1]), BB[3]]]];
  for (const [, inside, inter] of edges) {
    const out = []; if (!pts.length) break;
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length], ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(inter(prev, cur)); out.push(cur); } else if (pi) out.push(inter(prev, cur));
    }
    pts = out;
  }
  return pts;
}
function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1; const A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) { const t = Math.max(0, Math.min(1, ((pts[i][0] - A[0]) * dx + (pts[i][1] - A[1]) * dy) / L2)); const d = Math.hypot(pts[i][0] - (A[0] + t * dx), pts[i][1] - (A[1] + t * dy)); if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; s += r[i][0] * r[j][1] - r[j][0] * r[i][1]; } return Math.abs(s / 2); };
const enc = (pts) => { // enteros ×100 con deltas, [lon0,lat0,dlon,dlat,...]
  const o = []; let px = 0, py = 0; for (const p of pts) { const x = Math.round(p[0] * 100), y = Math.round(p[1] * 100); o.push(x - px, y - py); px = x; py = y; } return o;
};
function rings(geom, tol, minArea) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates, out = [];
  for (const poly of polys) { // solo anillo exterior
    const c = clip(poly[0]); if (c.length < 3) continue; const s = dp(c.concat([c[0]]), tol); if (s.length < 4) continue; const r = s.slice(0, -1);
    if (area(r) < minArea) continue; out.push(enc(r));
  }
  return out;
}
const inBB = (g) => { const flat = JSON.stringify(g.coordinates).match(/-?\d+\.?\d*/g).map(Number); for (let i = 0; i < flat.length; i += 2) if (flat[i] >= BB[0] && flat[i] <= BB[2] && flat[i + 1] >= BB[1] && flat[i + 1] <= BB[3]) return true; return false; };
const want = new Set(['Panama', 'Costa Rica', 'Colombia', 'Nicaragua', 'Honduras', 'Ecuador', 'Venezuela', 'Peru', 'Brazil', 'Jamaica', 'El Salvador', 'Guatemala', 'Belize', 'Cuba', 'Haiti', 'Dominican Rep.', 'Mexico', 'Guyana', 'Cayman Is.', 'Aruba', 'Curaçao', 'Colombia']);
const land = [], names = [];
for (const f of countries) {
  const n = f.properties.name; if (!want.has(n) && !inBB(f.geometry)) continue; if (!inBB(f.geometry)) continue;
  const pa = n === 'Panama'; const r = rings(f.geometry, pa ? 0.004 : 0.02, pa ? 0.00005 : 0.03);
  if (r.length) land.push({ n: pa ? 'Panamá' : n, pa: pa ? 1 : 0, r });
}
const prov = []; const lab = [];
for (const f of a1) {
  const p = f.properties; if (p.admin !== 'Panama') continue;
  const r = rings(f.geometry, 0.005, 0.00002); if (!r.length) continue;
  // etiqueta: centroide del mayor anillo
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates; let best = null, ba = -1;
  for (const pl of polys) { const a = area(pl[0]); if (a > ba) { ba = a; best = pl[0]; } }
  let cx = 0, cy = 0; best.forEach((q) => { cx += q[0]; cy += q[1]; }); cx /= best.length; cy /= best.length;
  const MAP = { 'Kuna Yala': 'Guna Yala', 'Emberá': 'Emberá-Wounaan', 'Ngöbe Buglé': 'Ngäbe-Buglé', 'Panama': 'Panamá' }, nm = MAP[p.name] || p.name;
  prov.push({ n: nm, r }); lab.push([nm, +cy.toFixed(2), +cx.toFixed(2)]);
}
const cl = [['Costa Rica', 9.9, -84.3], ['Colombia', 5.2, -74.2], ['Nicaragua', 12.9, -85.2], ['Honduras', 14.8, -86.9], ['Ecuador', -1.2, -78.4], ['Venezuela', 8.3, -69.5], ['Mar Caribe', 12.5, -78.5], ['Océano Pacífico', 4.8, -83.2]];
const GEO = { land, prov, lab, cl };
const js = '/* Geometría vectorial: Natural Earth (dominio público). Generado por tools/geo.mjs */\nconst GEO = ' + JSON.stringify(GEO) + ';\n';
fs.writeFileSync('app-0-geo.js', js);
console.log('land', land.map((l) => l.n + ':' + l.r.length).join(' '), '\nprov', prov.map((p) => p.n).join(', '), '\nbytes', js.length);
