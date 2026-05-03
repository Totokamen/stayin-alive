/*
 * Shared config for Stayin' Alive content scripts.
 * Kept in a dedicated file so version/constants are easy to maintain.
 */
(function () {
  'use strict';

  window.STAYIN_ALIVE_CONFIG = Object.freeze({
    VERSION: '2.4.2',
    POLL_FAST: 100,
    POLL_SLOW: 1000,
    BPM_MIN: 40,
    BPM_MAX: 180,
    RESULT_DELAY_MS: 1000,
    CRITICAL_THRESHOLD: 5,
    VOLUME_MIN: 0,
    VOLUME_MAX: 2,
    VOLUME_DEFAULT: 1,
    VOLUME_STEP: 0.05,
    DRAG_THRESHOLD: 4
  });
})();
