/**
 * boot.js — the safety net. A classic script, deliberately not a module.
 *
 * It does two jobs, and both exist because of the same failure on 2026-09-17: the
 * main module threw while loading, and the page just sat there. Every button inert,
 * nothing on screen, no way for a person to know anything was wrong or what to do.
 *
 *   1. Register the service worker, so the tool keeps working with no network and
 *      even if the host is down.
 *   2. Notice if the tool did not start, and SAY SO, instead of pretending.
 *
 * This file loads separately from app.js and shares nothing with it, so a failure
 * in the module cannot take the safety net down with it. Keep it small, keep it
 * dependency-free, and never import anything into it.
 */
(function () {
  'use strict';

  // app.js sets window.__cleantextReady as its very last statement. That is the
  // whole contract between these two files: if the flag never appears, the tool did
  // not finish starting, whatever the reason.
  var READY_TIMEOUT_MS = 6000;

  function showFailure(reason) {
    var box = document.getElementById('boot-error');
    if (!box || !box.hidden) return;
    box.hidden = false;
    var detail = document.getElementById('boot-error-detail');
    if (detail && reason) detail.textContent = String(reason).slice(0, 200);
    // The tool is not going to clean anything, so stop implying that it will.
    var input = document.getElementById('input');
    if (input) input.placeholder = 'Paste here (the cleaner did not load)';
  }

  // If anything throws before the tool signals it is ready, say so immediately
  // rather than waiting out the timer.
  window.addEventListener('error', function (e) {
    if (!window.__cleantextReady) showFailure(e && e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (!window.__cleantextReady) showFailure(e && e.reason && e.reason.message);
  });

  // The backstop, for the failures that throw nothing at all: a script that never
  // arrives, a network that hangs, a browser too old for modules.
  window.setTimeout(function () {
    if (!window.__cleantextReady) showFailure('');
  }, READY_TIMEOUT_MS);

  // Offline support. Everything here is optional: if any of it fails, the site
  // still works exactly as it did before, straight from the network.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        /* No offline support. Not worth telling anyone about. */
      });
    });
  }
})();
