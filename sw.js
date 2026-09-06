/*
	That Orange Guy Countdown — service worker
	License: CC-BY-NC-4 - zachduda.com/license
*/
var CACHE_VERSION = "v1";
var SHELL = "orange-shell-" + CACHE_VERSION;
var RUNTIME = "orange-runtime-" + CACHE_VERSION;
var KEEP = [SHELL, RUNTIME];
var CRITICAL = ["/", "/index.html", "/Content/script.js", "/icon.svg"];

// Nice to have offline, but not worth failing an install over.
var OPTIONAL = [
	"/site.webmanifest",
	"/favicon-16x16.png",
	"/favicon-32x32.png",
	"/favicon.ico",
	"/apple-touch-icon.png",
	"/android-chrome-192x192.png",
	"/android-chrome-512x512.png",
];

self.addEventListener("install", function (event) {
	event.waitUntil(
		caches
			.open(SHELL)
			.then(function (cache) {
				return cache.addAll(CRITICAL).then(function () {
					return Promise.all(
						OPTIONAL.map(function (path) {
							return cache.add(path).catch(function () {});
						})
					);
				});
			})
			.then(function () {
				return self.skipWaiting();
			})
	);
});

self.addEventListener("activate", function (event) {
	event.waitUntil(
		caches
			.keys()
			.then(function (names) {
				return Promise.all(
					names.map(function (name) {
						return KEEP.indexOf(name) === -1 ? caches.delete(name) : null;
					})
				);
			})
			.then(function () {
				return self.clients.claim();
			})
	);
});

self.addEventListener("message", function (event) {
	if (event.data === "skip-waiting") self.skipWaiting();
});

// --------------------------------------------------------------- strategies
function put(cacheName, request, response) {
	// Opaque responses (cross-origin, no-cors) report status 0 but are still
	// replayable for the script and stylesheet tags that asked for them.
	if (!response || (!response.ok && response.type !== "opaque")) return response;
	var copy = response.clone();
	caches.open(cacheName).then(function (cache) {
		cache.put(request, copy).catch(function () {});
	});
	return response;
}

// For our own HTML and JS: whatever is live wins, so a deploy lands on the
// next visit instead of the one after it.
function networkFirst(request, cacheName, fallback) {
	return fetch(request)
		.then(function (response) {
			return put(cacheName, request, response);
		})
		.catch(function () {
			return caches.match(request).then(function (hit) {
				if (hit) return hit;
				if (fallback) {
					return caches.match(fallback).then(function (page) {
						return page || Response.error();
					});
				}
				return Response.error();
			});
		});
}

// For our own images and the manifest: instant, refreshed in the background.
function staleWhileRevalidate(request, cacheName) {
	return caches.match(request).then(function (hit) {
		var network = fetch(request)
			.then(function (response) {
				return put(cacheName, request, response);
			})
			.catch(function () {
				return hit;
			});
		return hit || network;
	});
}

// For third-party CSS, fonts and Tailwind: versioned URLs that rarely move.
function cacheFirst(request, cacheName) {
	return caches.match(request).then(function (hit) {
		if (hit) {
			fetch(request)
				.then(function (response) {
					put(cacheName, request, response);
				})
				.catch(function () {});
			return hit;
		}
		return fetch(request)
			.then(function (response) {
				return put(cacheName, request, response);
			})
			.catch(function () {
				return Response.error();
			});
	});
}

// ------------------------------------------------------------------- routing
self.addEventListener("fetch", function (event) {
	var request = event.request;
	if (request.method !== "GET") return;

	var url;
	try {
		url = new URL(request.url);
	} catch (e) {
		return;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return;

	// The clock is the one thing that must never come from a cache: a stale
	// timestamp is worse than no timestamp. Let it hit the network and fail
	// honestly when offline, so the page falls back to its stored offset.
	if (url.hostname === "api.zachduda.com") return;

	// Analytics has no offline story and shouldn't fill the cache either.
	if (
		url.hostname === "www.googletagmanager.com" ||
		url.hostname === "www.google-analytics.com" ||
		url.hostname === "region1.google-analytics.com"
	) {
		return;
	}

	if (request.mode === "navigate") {
		event.respondWith(networkFirst(request, SHELL, "/index.html"));
		return;
	}

	if (url.origin === self.location.origin) {
		if (url.pathname === "/" || /\.(?:html|js)$/.test(url.pathname)) {
			event.respondWith(networkFirst(request, SHELL));
		} else {
			event.respondWith(staleWhileRevalidate(request, SHELL));
		}
		return;
	}

	event.respondWith(cacheFirst(request, RUNTIME));
});
