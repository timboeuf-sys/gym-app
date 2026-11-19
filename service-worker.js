// Offline-Betrieb: Alle App-Dateien werden beim ersten Laden zwischengespeichert.
// Danach startet die App komplett ohne Internet. Updates werden geladen, sobald wieder Internet da ist.
self.importScripts('./service-worker-assets.js');
self.addEventListener('install', event => event.waitUntil(onInstall(event)));
self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('fetch', event => event.respondWith(onFetch(event)));
self.addEventListener('message', event => { if (event.data === 'skipWaiting') self.skipWaiting(); });

const cacheNamePrefix = 'gym-offline-';
const cacheName = `${cacheNamePrefix}${self.assetsManifest.version}`;
const offlineAssetsInclude = [/\.dll$/, /\.pdb$/, /\.wasm/, /\.html/, /\.js$/, /\.json$/, /\.css$/, /\.woff2?$/, /\.png$/, /\.jpe?g$/, /\.ico$/, /\.blat$/, /\.dat$/, /\.webmanifest$/];
const offlineAssetsExclude = [/^service-worker\.js$/];
const baseUrl = new URL('./', self.location);
const manifestUrlList = self.assetsManifest.assets.map(asset => new URL(asset.url, baseUrl).href);

async function onInstall(event) {
    const assetsRequests = self.assetsManifest.assets
        .filter(asset => offlineAssetsInclude.some(p => p.test(asset.url)))
        .filter(asset => !offlineAssetsExclude.some(p => p.test(asset.url)))
        .map(asset => new Request(new URL(asset.url, baseUrl).href, { integrity: asset.hash, cache: 'no-cache' }));
    const cache = await caches.open(cacheName);
    await cache.addAll(assetsRequests);
    await cache.add(new Request(new URL('index.html', baseUrl).href, { cache: 'no-cache' }));
}

async function onActivate(event) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.filter(k => k.startsWith(cacheNamePrefix) && k !== cacheName).map(k => caches.delete(k)));
    await self.clients.claim();
}

async function onFetch(event) {
    let cached = null;
    if (event.request.method === 'GET') {
        const serveIndex = event.request.mode === 'navigate' && !manifestUrlList.some(u => u === event.request.url);
        const request = serveIndex ? new URL('index.html', baseUrl).href : event.request;
        const cache = await caches.open(cacheName);
        cached = await cache.match(request, { ignoreSearch: serveIndex });
    }
    return cached || fetch(event.request);
}
/* Manifest version: GACleMWe */
