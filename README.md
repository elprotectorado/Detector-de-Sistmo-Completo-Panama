# ISTMO · Sismo Panamá
Detector sísmico en un único Cloudflare Worker (IGC-UP + USGS + EMSC), PWA instalable, alertas, réplicas y API.
By @elprotectorado

## Estructura
- `src/` código fuente por partes (backend, shared, app-1…5, css, html, sw, docs)
- `build.mjs` ensambla todo en `worker.js` (un solo archivo)
- `worker.js` resultado listo para pegar en el editor en línea de Cloudflare
- `test/` pruebas del backend y humo del cliente

## Uso
    node build.mjs      # regenera worker.js
Pega `worker.js` en el editor de Cloudflare. Push opcional: KV `SISMO_KV` + Cron `* * * * *`.

## Licencia y datos
Código bajo licencia MIT (ver `LICENSE`). Los datos sísmicos pertenecen a sus fuentes (IGC-UP, USGS, EMSC) y se rigen por sus propios términos de uso.
