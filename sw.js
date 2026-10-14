// Scribe service worker: caches the app files so it opens and works offline.
// Bump VERSION whenever any app file changes so phones pick up the new files.
var VERSION = 'scribe-v1';
var FILES = [
  './', './index.html', './app.js', './worker.js', './pcm-tap.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
  './vendor/transformers.min.js', './vendor/ort-loader.js', './vendor/ort-wasm-simd-threaded.wasm.0', './vendor/ort-wasm-simd-threaded.wasm.1'
];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(VERSION).then(function(c){ return c.addAll(FILES); }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k.indexOf('scribe-') === 0 && k !== VERSION; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function(hit){
      return hit || fetch(req);
    })
  );
});
