/*
	That Orange Guy Countdown
	A silly little app written by Zach Duda.   <Discord>: zachduda.com/discord
	License: CC-BY-NC-4 - zachduda.com/license

	This is the only copy of the script. index.html loads it with `defer`.
*/
(function () {
	"use strict";

	// ---------------------------------------------------------------- config
	var TERM_START = 1737388800000; // 2025-01-20 11:00 ET
	var TERM_END = 1863802800000; // 2029-01-20 12:00 ET
	var TERM_MS = TERM_END - TERM_START;

	var TICK_MS = 100; // display granularity while visible
	var REDUCED_TICK_MS = 1000; // ...when the visitor asked for less motion
	var RESYNC_AFTER_MS = 300000; // only re-sync a tab that was away 5+ minutes
	var TIME_API = "https://api.zachduda.com/time.php";
	var FETCH_TIMEOUT_MS = 4000;

	// ----------------------------------------------------------------- nodes
	function sid(id) {
		return document.getElementById(id);
	}

	var el = {
		days: sid("cd-days"),
		hours: sid("cd-hours"),
		mins: sid("cd-mins"),
		secs: sid("cd-secs"),
		frac: sid("cd-frac"),
		bar: sid("term-bar"),
		track: sid("term-track"),
		pct: sid("term-pct"),
		year: sid("year"),
	};

	if (!el.days || !el.hours || !el.mins || !el.secs) return;

	var nf = new Intl.NumberFormat();
	var reduceMotion = window.matchMedia
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: null;

	// ----------------------------------------------------------------- clock
	// performance.now() is monotonic: it keeps counting while the tab is hidden
	// and is immune to the device clock being changed underneath us. We take a
	// single reading from the time API, store the offset, and never poll again.
	var TIME_ORIGIN =
		typeof performance.timeOrigin === "number"
			? performance.timeOrigin
			: Date.now() - performance.now();

	var skew = 0; // serverNow - deviceNow, in ms
	var lastSyncAt = 0;
	var syncing = null;

	function now() {
		return TIME_ORIGIN + performance.now() + skew;
	}

	function syncClock() {
		if (syncing) return syncing;

		var controller =
			typeof AbortController === "function" ? new AbortController() : null;
		var bail = controller
			? setTimeout(function () {
					controller.abort();
			  }, FETCH_TIMEOUT_MS)
			: null;
		var sentAt = performance.now();

		syncing = fetch(TIME_API, {
			cache: "no-store",
			signal: controller ? controller.signal : undefined,
		})
			.then(function (res) {
				if (!res.ok) throw new Error("HTTP " + res.status);
				return res.json();
			})
			.then(function (body) {
				var stamp = new Date(body.date).getTime();
				if (!isFinite(stamp)) throw new Error("unparseable date");

				// The server wrote `stamp` somewhere inside the round trip; assume
				// the midpoint, so by the time the response landed the true time had
				// already moved on by half the round trip.
				var rtt = performance.now() - sentAt;
				skew = stamp + rtt / 2 - (TIME_ORIGIN + performance.now());
			})
			.catch(function () {
				skew = 0; // API unreachable: fall back to the device clock
			})
			.then(function () {
				if (bail) clearTimeout(bail);
				lastSyncAt = Date.now();
				syncing = null;
			});

		return syncing;
	}

	// ---------------------------------------------------------------- render
	var shown = {}; // last value written per node, so we only touch what changed

	function write(node, key, value) {
		if (!node || shown[key] === value) return;
		node.textContent = value;
		shown[key] = value;
	}

	function pad(n) {
		return n < 10 ? "0" + n : "" + n;
	}

	function render() {
		var left = TERM_END - now();
		if (left < 0) left = 0;

		write(el.days, "days", nf.format(Math.floor(left / 86400000)));
		write(el.hours, "hours", pad(Math.floor(left / 3600000) % 24));
		write(el.mins, "mins", pad(Math.floor(left / 60000) % 60));
		write(el.secs, "secs", pad(Math.floor(left / 1000) % 60));
		write(el.frac, "frac", "." + Math.floor((left % 1000) / 100));

		var pct = ((now() - TERM_START) / TERM_MS) * 100;
		if (pct < 0) pct = 0;
		if (pct > 100) pct = 100;

		// Four decimals keeps the bar creeping without repainting every tick.
		var width = pct.toFixed(4) + "%";
		if (shown.width !== width) {
			if (el.bar) el.bar.style.width = width;
			shown.width = width;
		}

		var label = pct.toFixed(2);
		if (shown.pct !== label) {
			shown.pct = label;
			if (el.pct) el.pct.textContent = label + "%";
			if (el.track) {
				el.track.setAttribute("aria-valuenow", label);
				el.track.setAttribute("aria-valuetext", label + " percent complete");
			}
		}

		return left;
	}

	// ------------------------------------------------------------------ loop
	// A self-correcting setTimeout aligned to the next 100ms boundary. Browsers
	// already throttle background timers to ~1/s, so there is no hidden-tab
	// bookkeeping to do here.
	var timer = null;

	function loop() {
		if (render() <= 0) {
			document.documentElement.classList.add("term-over");
			return;
		}
		var step = reduceMotion && reduceMotion.matches ? REDUCED_TICK_MS : TICK_MS;
		timer = setTimeout(loop, step - (Date.now() % step));
	}

	function restart() {
		if (timer) clearTimeout(timer);
		loop();
	}

	document.addEventListener("visibilitychange", function () {
		if (document.hidden) return;
		restart(); // catch up instantly instead of waiting out a throttled tick
		if (Date.now() - lastSyncAt > RESYNC_AFTER_MS) syncClock().then(render);
	});

	// Safari/Firefox restore from the back-forward cache with timers frozen.
	window.addEventListener("pageshow", function (e) {
		if (e.persisted) restart();
	});

	// ------------------------------------------------------------------ init
	if (el.year) el.year.textContent = new Date().getFullYear();

	// Paint from the device clock right away — the countdown is the page, it
	// should not wait on a network round trip — then correct once the API answers.
	loop();
	syncClock().then(render);
})();
