/*
 * Bootstrap helpers for loading persisted settings.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});

  function loadSettings(options) {
    const {
      setSoundEnabled,
      setBreathingEnabled,
      setCollapsed,
      setOverlayPosition,
      setVolumeMultiplier,
      clampVolume
    } = options;

    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['soundEnabled', 'heartbeatEnabled', 'breathingEnabled',
          'overlayPosition', 'volumeMultiplier', 'collapsed'],
        (data) => {
          if (data.soundEnabled !== undefined) {
            setSoundEnabled(data.soundEnabled);
          } else if (data.heartbeatEnabled !== undefined) {
            // Legacy key migration
            setSoundEnabled(data.heartbeatEnabled);
            chrome.storage.local.set({ soundEnabled: data.heartbeatEnabled });
            chrome.storage.local.remove('heartbeatEnabled');
          }

          if (typeof data.breathingEnabled === 'boolean') {
            setBreathingEnabled(data.breathingEnabled);
          }
          if (typeof data.collapsed === 'boolean') {
            setCollapsed(data.collapsed);
          }
          if (data.overlayPosition) {
            setOverlayPosition(data.overlayPosition);
          }
          if (Number.isFinite(data.volumeMultiplier)) {
            setVolumeMultiplier(clampVolume(data.volumeMultiplier));
          }
          resolve();
        }
      );
    });
  }

  root.bootstrap = Object.freeze({
    loadSettings
  });
})();
