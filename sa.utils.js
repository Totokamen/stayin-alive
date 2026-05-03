/*
 * Shared utility helpers for Stayin' Alive content scripts.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});

  root.utils = Object.freeze({
    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
  });
})();
