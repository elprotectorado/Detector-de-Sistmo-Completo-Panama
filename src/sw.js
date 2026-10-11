/* ISTMO · Service Worker — caché offline, Web Push, notificaciones con acciones, sincronización periódica */
importScripts('/shared.js');
const V = '__VERSION__';
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
  if (/basemaps\.cartocdn\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com/.test(u.hostname)) { // teselas: caché primero
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
