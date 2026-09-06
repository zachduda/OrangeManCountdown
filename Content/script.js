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

	// A device clock can legitimately be hours out. Anything past a year is a
	// corrupt or hand-edited storage entry, not a clock we should trust.
	var MAX_OFFSET_MS = 31536000000;

	var CLOCK_KEY = "ogc.clock"; // { offset, at }
	var MODE_KEY = "ogc.mode"; // "left" | "served"

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
		timer: sid("countdown"),
		caption: sid("cd-caption"),
		modeLeft: sid("mode-left"),
		modeServed: sid("mode-served"),
		status: sid("net-status"),
	};

	if (!el.days || !el.hours || !el.mins || !el.secs) return;

	var nf = new Intl.NumberFormat();
	var reduceMotion = window.matchMedia
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: null;

	// --------------------------------------------------------------- storage
	// Private browsing and blocked-cookie settings make localStorage throw on
	// access, not just on write, so every touch is guarded.
	function load(key) {
		try {
			var raw = localStorage.getItem(key);
			return raw === null ? null : JSON.parse(raw);
		} catch (e) {
			return null;
		}
	}

	function save(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch (e) {
			/* full, disabled, or private mode — the page works without it */
		}
	}

	// ----------------------------------------------------------------- clock
	// Two clocks are in play. performance.now() is monotonic, so it drives the
	// countdown within a session and cannot be yanked around by the system
	// clock. Date.now() is the wall clock, and the offset we persist has to be
	// expressed against it, since performance's origin is per-page-load.
	var TIME_ORIGIN =
		typeof performance.timeOrigin === "number"
			? performance.timeOrigin
			: Date.now() - performance.now();

	var skew = 0; // serverNow - deviceNow, in ms
	var lastSyncAt = 0;
	var syncing = null;
	var source = "device"; // "device" | "stored" | "live"

	function now() {
		return TIME_ORIGIN + performance.now() + skew;
	}

	// Re-use the offset from a previous visit so the very first frame is right,
	// even with no network. Refreshed below if we can reach the API.
	var stored = load(CLOCK_KEY);
	if (
		stored &&
		typeof stored.offset === "number" &&
		isFinite(stored.offset) &&
		Math.abs(stored.offset) < MAX_OFFSET_MS
	) {
		skew = stored.offset;
		source = "stored";
	}

	function syncClock() {
		if (syncing) return syncing;

		// Don't bother the network stack when the browser already knows there
		// is nothing out there; the stored offset stands.
		if (navigator.onLine === false) {
			showStatus();
			return Promise.resolve();
		}

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
				var trueNow = stamp + rtt / 2;

				skew = trueNow - (TIME_ORIGIN + performance.now());
				source = "live";
				save(CLOCK_KEY, { offset: trueNow - Date.now(), at: Date.now() });
			})
			.catch(function () {
				// Keep whatever offset we already had. Zeroing it here would throw
				// away a good stored correction over one failed request.
			})
			.then(function () {
				if (bail) clearTimeout(bail);
				lastSyncAt = Date.now();
				syncing = null;
				showStatus();
			});

		return syncing;
	}

	function showStatus() {
		if (!el.status) return;
		var offline = navigator.onLine === false || source !== "live";
		if (!offline) {
			el.status.hidden = true;
			return;
		}
		el.status.textContent =
			source === "stored"
				? "Offline — counting from the clock offset saved on your last visit."
				: "Offline — counting from this device's clock.";
		el.status.hidden = false;
	}

	// ------------------------------------------------------------------ mode
	// "left"   — time remaining in the term (default)
	// "served" — time elapsed since day one
	var mode = load(MODE_KEY) === "served" ? "served" : "left";

	function applyMode(next, remember) {
		mode = next === "served" ? "served" : "left";
		if (remember) save(MODE_KEY, mode);

		if (el.modeLeft)
			el.modeLeft.setAttribute("aria-pressed", mode === "left" ? "true" : "false");
		if (el.modeServed)
			el.modeServed.setAttribute("aria-pressed", mode === "served" ? "true" : "false");
		if (el.timer)
			el.timer.setAttribute(
				"aria-label",
				mode === "served"
					? "Time served so far in the current term"
					: "Time remaining in the current term"
			);
		if (el.caption)
			el.caption.textContent =
				mode === "served" ? "served so far" : "still to go";

		shown = {}; // every digit is potentially different now
		render();
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
		var elapsed = now() - TERM_START;
		if (elapsed < 0) elapsed = 0;
		if (elapsed > TERM_MS) elapsed = TERM_MS;

		var span = mode === "served" ? elapsed : TERM_MS - elapsed;

		write(el.days, "days", nf.format(Math.floor(span / 86400000)));
		write(el.hours, "hours", pad(Math.floor(span / 3600000) % 24));
		write(el.mins, "mins", pad(Math.floor(span / 60000) % 60));
		write(el.secs, "secs", pad(Math.floor(span / 1000) % 60));
		write(el.frac, "frac", "." + Math.floor((span % 1000) / 100));

		var pct = (elapsed / TERM_MS) * 100;

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

		return elapsed >= TERM_MS;
	}

	// ------------------------------------------------------------------ loop
	// A self-correcting setTimeout aligned to the next 100ms boundary. Browsers
	// already throttle background timers to ~1/s, so there is no hidden-tab
	// bookkeeping to do here.
	var timer = null;

	function loop() {
		if (render()) {
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

	// ----------------------------------------------------------------- wiring
	if (el.modeLeft)
		el.modeLeft.addEventListener("click", function () {
			applyMode("left", true);
		});
	if (el.modeServed)
		el.modeServed.addEventListener("click", function () {
			applyMode("served", true);
		});

	document.addEventListener("visibilitychange", function () {
		if (document.hidden) return;
		restart(); // catch up instantly instead of waiting out a throttled tick
		if (Date.now() - lastSyncAt > RESYNC_AFTER_MS) syncClock().then(render);
	});

	window.addEventListener("online", function () {
		syncClock().then(render);
	});
	window.addEventListener("offline", showStatus);

	// Safari/Firefox restore from the back-forward cache with timers frozen.
	window.addEventListener("pageshow", function (e) {
		if (e.persisted) restart();
	});

	// ------------------------------------------------------------------ init
	if (el.year) el.year.textContent = new Date().getFullYear();

	applyMode(mode, false);
	showStatus();

	// Paint from the best offset we have right away — the countdown is the
	// page, it should not wait on a network round trip — then correct once the
	// API answers, if it ever does.
	loop();
	syncClock().then(render);
})();
