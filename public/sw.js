/**
 * sw.js — the offline layer.
 *
 * Goal: after one visit, this tool works with no internet at all, and it works
 * even if the host is down. It also loads instantly, because nothing is fetched
 * over the network to render it.
 *
 * THE RULE THAT SHAPES THIS FILE: every asset is cached TOGETHER, under a cache
 * name that carries the version, and the old cache is deleted the moment the new
 * one is ready. Files are never updated one at a time.
 *
 * That is not fussiness. On 2026-09-17 a browser holding a one-hour-old app.js met
 * freshly deployed HTML, the JS reached for an element the HTML no longer had, the
 * module threw on load, and the page was completely dead with nothing on screen to
 * say so. A cache that can hold a new index.html beside an old app.js will do that
 * again, only worse, because a service worker cache outlives a browser restart.
 *
 * VERSION is stamped by ops/deploy.mjs from a hash of the assets themselves, so it
 * changes when they change and not otherwise.
 *
 * KILL SWITCH. If this ever misbehaves, replace the whole file with:
 *   self.addEventListener('install', () => self.skipWaiting());
 *   self.addEventListener('activate', e => e.waitUntil((async () => {
 *     for (const k of await caches.keys()) await caches.delete(k);
 *     await self.registration.unregister();
 *     for (const c of await self.clients.matchAll()) c.navigate(c.url);
 *   })()));
 * Deploy that, and every browser drops the worker and its caches on next visit.
 */

const VERSION = '07173fcf5e68';
const CACHE = 'cleantext-' + VERSION;

const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/clean.js',
  '/richtext.js',
  '/boot.js',
  '/favicon.svg',
  '/privacy.html',
  '/terms.html',
  // The other tools. Precached with everything else, as one set: a browser that
  // has the new clean.js and a page from before it existed is the combination
  // this whole file is shaped to prevent.
  '/tool.js',
  '/spaces.js',
  '/markdown.js',
  '/linebreaks.js',
  '/titlecase.js',
  '/remove-extra-spaces/',
  '/markdown-to-plain-text/',
  '/remove-line-breaks/',
  '/title-case-converter/',
  '/tools/',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `cache: 'reload'` bypasses the browser's own HTTP cache, so a new version can
    // never precache a stale copy of a file it is supposed to be replacing.
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(name => name !== CACHE).map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  // The private stats page is never cached and never served from here.
  if (url.pathname.startsWith('/stats')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    /* PAGES GO TO THE NETWORK FIRST, cache second.
     *
     * Two reasons, and the second one is not obvious. It guarantees a visitor sees
     * the current version rather than yesterday's. And page views are counted at the
     * edge on the server, so a page served straight from this cache would never
     * reach the server and would never be counted. Serving stale pages AND
     * undercounting is a bad trade for the few milliseconds it saves on a 14 KB file.
     *
     * Assets stay cache-first, because they are precached as one consistent set and
     * they are where the speed actually is. */
    if (request.mode === 'navigate') {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) cache.put(url.pathname, fresh.clone());
        return fresh;
      } catch (error) {
        const shell = (await cache.match(url.pathname)) || (await cache.match('/index.html'));
        if (shell) return shell;
        throw error;
      }
    }

    /* SCRIPTS AND STYLES GO TO THE NETWORK FIRST TOO. See BUG-008.
     *
     * This file used to serve every asset cache-first, and that quietly exempted
     * the service worker from D24, the rule that scripts and styles are always
     * revalidated. The hole it left is only open for one load, and it is the
     * worst one there is:
     *
     *   A returning visitor arrives just after a deploy. The OLD worker is still
     *   the one controlling the page. The navigation is network-first, so they
     *   get the NEW html — which asks for an export that the OLD clean.js, sitting
     *   in the old worker's cache, does not have. The module throws on load and
     *   the page is dead. Exactly BUG-005, resurrected through the cache that was
     *   added to make the site robust.
     *
     * The atomic versioned cache cannot fix this on its own: it guarantees the
     * assets in a cache match EACH OTHER, not that they match the page the visitor
     * was just served. Going to the network for the two file types that can kill
     * the page closes it, costs a 304 on a file already revalidated by its own
     * headers, and still falls back to the cache when there is no network at all.
     *
     * Everything else — the icon, the OG image — stays cache-first. Those cannot
     * break a page by being a version behind. */
    const critical = request.destination === 'script' || request.destination === 'style' ||
                     /\.(js|css)$/.test(url.pathname);

    if (critical) {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (error) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;                     // offline: a matched set is better than nothing
        throw error;
      }
    }

    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (error) {
      throw error;
    }
  })());
});
