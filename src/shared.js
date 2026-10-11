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
