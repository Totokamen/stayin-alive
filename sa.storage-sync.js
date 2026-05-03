/*
 * chrome.storage synchronization wiring for Stayin' Alive.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});

  function registerStorageSync(options) {
    const {
      setSoundEnabled,
      setBreathingEnabled,
      onVolumeMultiplierChange,
      onCollapsedChange
    } = options;

    const listener = (changes) => {
      // Storage-driven mute snapshot invalidation.
      //
      // sa.mute owns the volumeBeforeMute / breathingBeforeMute keys. As long
      // as both exist in storage, a future M (or popup tick) will perform a
      // restore. The moment the user touches a single audio axis directly
      // (slider, breath toggle, popup writing only soundEnabled, +/-, H...)
      // the snapshot is no longer accurate, so we drop volumeBeforeMute and
      // the next M falls into the "fresh mute" branch. breathingBeforeMute
      // stays sticky on purpose (preserves the user's original deliberate
      // breath choice across re-mutes).
      //
      // Mute / unmute writes done by sa.mute itself are NOT user touches;
      // saMute.isMuteOperationChange spots them by the presence of the
      // snapshot keys in changes (mute path) or by all three audio axes
      // changing together (unmute path).
      const mute = root.mute;
      const audioAxes = ['soundEnabled', 'volumeMultiplier', 'breathingEnabled'];
      const axesChanged = audioAxes.some(k => changes[k] !== undefined);
      if (mute && axesChanged && !mute.isMuteOperationChange(changes)) {
        chrome.storage.local.remove('volumeBeforeMute');
      }

      if (changes.soundEnabled) {
        setSoundEnabled(changes.soundEnabled.newValue);
      }
      if (changes.breathingEnabled) {
        setBreathingEnabled(!!changes.breathingEnabled.newValue);
      }
      if (changes.volumeMultiplier) {
        const v = changes.volumeMultiplier.newValue;
        if (Number.isFinite(v)) onVolumeMultiplierChange(v);
      }
      if (changes.collapsed !== undefined) {
        onCollapsedChange(!!changes.collapsed.newValue);
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  root.storageSync = Object.freeze({
    registerStorageSync
  });
})();
