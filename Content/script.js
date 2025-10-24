/*
	A silly little app written by Zach Duda.																															<Discord>: zachduda.com/discord
	License: CC-BY-NC-4
	
	This script is not used. A minified version is inline the HTML due to size <3kb
*/
(function () {
  // === DOM helpers ===
  function sid(id) { return document.getElementById(id); }
  const yearEl = sid("year");
  const daysEl = sid("cd-days");    // create these elements in HTML
  const hoursEl = sid("cd-hours");
  const minsEl = sid("cd-mins");
  const secsEl = sid("cd-secs");
  const fracEl = sid("cd-frac");    // for .Xs when active
  const prcEl  = sid("cd-prc");
  const rootHtmlEl = sid("thtml");  // legacy container (kept for year and fallback)
  const loadhtml = rootHtmlEl ? rootHtmlEl.innerHTML : "";

  // If you don't have separate nodes, you can create them or fall back to innerHTML.
  const useFieldNodes = !!(daysEl && hoursEl && minsEl && secsEl && fracEl && prcEl);

  // === Config ===
  const END = 1831996800000; // 2028-01-20 11:00AM EST/EDT
  const BEG = 1737388800000; // 2025-01-20 11:00AM EST/EDT
  const NORMAL_UF = 100;     // 100ms visual granularity (shows .x)
  const SLOW_UF = 1000;      // 1s while hidden
  const RESYNC_INTERVAL = 60000; // 60s regular
  const BRIEF_RESYNC_PERIOD = 15000; // after focus, sync for this period more often
  const BRIEF_RESYNC_INTERVAL = 5000; // 5s for brief period
  const SYNC_SAMPLES = 5;    // median-of-5 samples
  const FOCUS_DEBOUNCE_MS = 200;

  // === State ===
  let uf = NORMAL_UF;
  let serverBase = null;   // adjusted server ms timestamp (ms since epoch)
  let perfAtSync = null;   // performance.now() at time of serverBase
  let syncRtt = null;      // last RTT
  let tmInterval = null;   // setInterval fallback id (used when hidden)
  let rafId = null;        // rAF id when visible
  let lastDisplayed = {};  // last displayed parts to avoid DOM writes
  let hidden = false;
  let blurPerf = null;
  let lastFocusOrBlur = 0;
  let lastSyncTime = 0;
  let briefResyncUntil = 0;

  const nf = new Intl.NumberFormat(); // commas

  // === Utility functions ===
  function nowSynced() {
    if (serverBase != null && perfAtSync != null) {
      return serverBase + (performance.now() - perfAtSync);
    }
    return Date.now();
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function pad(n) { return n.toString().padStart(2, "0"); }

  function computeParts(df) {
    if (df < 0) df = 0;
    const _s = 1000, _m = _s * 60, _h = _m * 60, _d = _h * 24;
    const days = Math.floor(df / _d);
    const hours = Math.floor((df % _d) / _h);
    const mins = Math.floor((df % _h) / _m);
    const secs = Math.floor((df % _m) / _s);
    const frac = Math.floor((df % _s) / 100); // 0-9 -> .X
    return { days, hours, mins, secs, frac, remaining: df };
  }

  function updateDOM(parts) {
    // Only update changed fields.
    if (useFieldNodes) {
      if (lastDisplayed.days !== parts.days) {
        daysEl.textContent = nf.format(parts.days) + " days";
        lastDisplayed.days = parts.days;
      }
      if (lastDisplayed.hours !== parts.hours) {
        hoursEl.textContent = parts.hours + "h";
        lastDisplayed.hours = parts.hours;
      }
      if (lastDisplayed.mins !== parts.mins) {
        minsEl.textContent = parts.mins + "m";
        lastDisplayed.mins = parts.mins;
      }
      if (lastDisplayed.secs !== parts.secs) {
        secsEl.textContent = parts.secs;
        lastDisplayed.secs = parts.secs;
      }
      if (uf < 1000) {
        if (lastDisplayed.frac !== parts.frac) {
          fracEl.textContent = "." + parts.frac + "s";
          lastDisplayed.frac = parts.frac;
        }
      } else {
        if (lastDisplayed.frac !== "s") {
          fracEl.textContent = "s";
          lastDisplayed.frac = "s";
        }
      }
      // progress percent
      const elapsed = clamp(nowSynced() - BEG, 0, END - BEG);
      const prc = parseFloat(((elapsed / (END - BEG)) * 100).toFixed(2));
      if (lastDisplayed.prc !== prc) {
        prcEl.innerHTML = "Orange Man's term is <b class='text-orange-400'>" + prc + "%</b> complete.";
        lastDisplayed.prc = prc;
      }
    } else {
      // fallback: single container innerHTML but diff full string
      const showMs = uf < 1000;
      let html = nf.format(parts.days) + " days " + parts.hours + "h " + parts.mins + "m " + parts.secs;
      html += showMs ? "." + parts.frac + "s" : "s";
      const elapsed = clamp(nowSynced() - BEG, 0, END - BEG);
      const prc = parseFloat(((elapsed / (END - BEG)) * 100).toFixed(2));
      html += "<br><p class='pt-3 text-sm text-slate-400'>Orange Man's term is <b class='text-orange-400'>" + prc + "%</b> complete.</p>";
      if (lastDisplayed.html !== html) {
        rootHtmlEl.innerHTML = html;
        lastDisplayed.html = html;
      }
    }
  }

  function stopAllTimers() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (tmInterval) { clearInterval(tmInterval); tmInterval = null; }
  }

  // === Timing loop ===
  function tick() {
    const srt = nowSynced();
    const df = END - srt;
    const parts = computeParts(df);
    updateDOM(parts);
    if (parts.remaining <= 0) {
      stopAllTimers();
    }
  }

  function startVisibleLoop() {
    stopAllTimers();
    // rAF loop; we use rAF and only redraw when needed (updateDOM does diffs)
    function rafLoop() {
      tick();
      rafId = requestAnimationFrame(rafLoop);
    }
    rafLoop();
  }

  function startHiddenLoop() {
    stopAllTimers();
    tmInterval = setInterval(tick, uf);
    // run one immediate tick
    tick();
  }

  function startLoop() {
    if (!document.hidden && typeof requestAnimationFrame === "function") {
      startVisibleLoop();
    } else {
      startHiddenLoop();
    }
  }

  // === Robust server sync (median-of-N) ===
  function fetchServerTimeSample() {
    const start = Date.now();
    return fetch("https://api.zachduda.com/time.php", { cache: "no-store" })
      .then(r => r.text())
      .then(text => {
        const endt = Date.now();
        const rtt = endt - start;
        const parsed = JSON.parse(text);
        const serverMs = new Date(parsed.date).getTime();
        // Adjust by half RTT
        const adjusted = serverMs - Math.round(rtt / 2);
        return { adjusted, rtt };
      })
      .catch(() => {
        const now = Date.now();
        return { adjusted: now, rtt: 0 };
      });
  }

  async function medianSyncSamples(n) {
    const promises = [];
    for (let i = 0; i < n; i++) promises.push(fetchServerTimeSample());
    const results = await Promise.all(promises);
    // sort by adjusted times and take median
    const adjustedArr = results.map(r => r.adjusted).sort((a, b) => a - b);
    const rttArr = results.map(r => r.rtt).sort((a, b) => a - b);
    const medianAdjusted = adjustedArr[Math.floor(adjustedArr.length / 2)];
    const medianRtt = rttArr[Math.floor(rttArr.length / 2)];
    // set serverBase using performance.now() reference
    serverBase = medianAdjusted;
    perfAtSync = performance.now();
    syncRtt = medianRtt;
    lastSyncTime = Date.now();
  }

  // === Sync management and scheduling ===
  let ongoingSync = null;
  async function sync(nowInit = false) {
    // Prevent overlapping syncs
    if (ongoingSync) return ongoingSync;
    ongoingSync = (async () => {
      try {
        await medianSyncSamples(SYNC_SAMPLES);
        if (nowInit && yearEl) yearEl.textContent = new Date(nowSynced()).getFullYear();
      } finally {
        ongoingSync = null;
      }
    })();
    return ongoingSync;
  }

  // Periodic sync loop with brief high-frequency resync after focus
  setInterval(() => {
    const now = Date.now();
    const interval = (now < briefResyncUntil) ? BRIEF_RESYNC_INTERVAL : RESYNC_INTERVAL;
    if (now - lastSyncTime >= interval) sync();
  }, 1000);

  // === Visibility, focus/blur handling with debounce ===
  function handleBlur() {
    const now = Date.now();
    if (now - lastFocusOrBlur < FOCUS_DEBOUNCE_MS) return;
    lastFocusOrBlur = now;
    hidden = true;
    blurPerf = performance.now();
    // reduce frequency
    uf = SLOW_UF;
    startLoop();
  }

  function handleFocus() {
    const now = Date.now();
    if (now - lastFocusOrBlur < FOCUS_DEBOUNCE_MS) return;
    lastFocusOrBlur = now;
    hidden = false;
    // account for time passage during blur using perf
    if (blurPerf != null && perfAtSync != null) {
      const elapsed = performance.now() - blurPerf;
      perfAtSync += elapsed; // advance reference so nowSynced is continuous
    }
    blurPerf = null;
    uf = NORMAL_UF;
    // quick UI reset if needed
    if (rootHtmlEl) rootHtmlEl.innerHTML = loadhtml;
    // resync immediately and briefly increase resync frequency
    sync(true).then(() => {
      briefResyncUntil = Date.now() + BRIEF_RESYNC_PERIOD;
      startLoop();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) handleBlur(); else handleFocus();
  });
  window.addEventListener("blur", handleBlur);
  window.addEventListener("focus", handleFocus);

  // Ensure we clear timers when page unloads
  window.addEventListener("pagehide", stopAllTimers);
  window.addEventListener("beforeunload", stopAllTimers);

  // === Initialization ===
  (async function init() {
    // Ensure nodes exist or create fallback structure if not
    //if (!useFieldNodes) {
      // Optional: create elements inside thtml if specific nodes are missing.
      // Keep simple fallback: set rootHtmlEl content on init via sync(true)
    //}
    await sync(true);
    startLoop();
  })();

})();