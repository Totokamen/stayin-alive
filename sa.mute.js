/*
 * Stayin' Alive - shared true-mute API.
 *
 * Single source of truth for the mute/unmute state machine. Loaded by both
 * the content script (M hotkey) and the popup (Audio feedback checkbox) so
 * the two entry points share identical semantics.
 *
 * Storage contract (chrome.storage.local):
 *   - soundEnabled, volumeMultiplier, breathingEnabled: the three "audio
 *     axes" the user sees. Owned by everyone.
 *   - volumeBeforeMute: present iff a restore is currently available (the
 *     user has muted via this module and hasn't invalidated the snapshot
 *     by touching an axis directly). Owned by THIS module.
 *   - breathingBeforeMute: STICKY across re-mutes. Set on the first mute,
 *     never overwritten on subsequent mutes, only removed by a full unmute.
 *     Encodes the user's "original deliberate breath choice" so a restore
 *     after slider/breath touches still returns to that value. Owned by
 *     THIS module.
 *
 * IMPORTANT: nothing outside this module should read or write the two
 * *BeforeMute keys. The storage-sync listener relies on the invariant
 * "those keys appear in onChanged.changes only when sa.mute did the write".
 *
 * Why no in-memory flags (muteRestoreValid / muteOpInFlight)?
 * Popup, content scripts on multiple Lichess tabs and any future settings
 * page each live in their own JavaScript realm. An in-memory flag would
 * fragment across realms. Using storage as the only source of truth keeps
 * the state machine consistent across all of them with zero coordination.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});
  const cfg = window.STAYIN_ALIVE_CONFIG || {};
  const VOLUME_DEFAULT = cfg.VOLUME_DEFAULT ?? 1;

  // Single read of every key the state machine cares about.
  function _readSnapshot() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['soundEnabled', 'volumeMultiplier', 'breathingEnabled',
          'volumeBeforeMute', 'breathingBeforeMute'],
        resolve
      );
    });
  }

  /**
   * Forces the muted state. Saves a fresh volume snapshot and (on the first
   * mute only) a sticky breath snapshot, then zeros all three audio axes in
   * a single atomic set() so the storage-sync listener sees the snapshot
   * keys in the change-set and recognises the write as a mute op.
   */
  function _writeMute(data) {
    return new Promise((resolve) => {
      const hasOldVolSave = Number.isFinite(data.volumeBeforeMute);
      const hasOldBreathSave = typeof data.breathingBeforeMute === 'boolean';

      // Volume save refreshes with the current audible value. If the user
      // already invalidated the snapshot by sliding to 0, fall back to the
      // previous save (if any), and finally to VOLUME_DEFAULT, so a future
      // restore always lands on something audible.
      const saveVol = data.volumeMultiplier > 0
        ? data.volumeMultiplier
        : (hasOldVolSave && data.volumeBeforeMute > 0
          ? data.volumeBeforeMute
          : VOLUME_DEFAULT);

      // Breath save is STICKY: only captured on the first mute, never
      // overwritten on re-mutes. Preserves the user's original deliberate
      // choice (ON / OFF) regardless of any toggling that happened during
      // the muted period.
      const saveBreath = hasOldBreathSave
        ? data.breathingBeforeMute
        : (typeof data.breathingEnabled === 'boolean'
          ? data.breathingEnabled
          : true);

      chrome.storage.local.set({
        volumeBeforeMute: saveVol,
        breathingBeforeMute: saveBreath,
        soundEnabled: false,
        volumeMultiplier: 0,
        breathingEnabled: false
      }, resolve);
    });
  }

  /**
   * Forces the unmuted state. Restores volume from the snapshot if present
   * (else VOLUME_DEFAULT), restores breath from the sticky snapshot if
   * present (else true), then removes both snapshot keys to mark "no
   * restore available" until the next mute.
   *
   * The set+remove are issued back-to-back. Chrome's storage.onChanged will
   * fire two separate events: the first carries the three axes (unmute is
   * recognised by the storage-sync listener via the "all three axes
   * together" branch), the second carries only the snapshot key removals
   * which the listener ignores.
   */
  function _writeUnmute(data) {
    return new Promise((resolve) => {
      const hasVolSave = Number.isFinite(data.volumeBeforeMute);
      const hasBreathSave = typeof data.breathingBeforeMute === 'boolean';
      // Volume restore priority:
      //   1. Snapshot value, when present and positive (canonical pre-mute).
      //   2. Current volumeMultiplier, when positive (preserves a deliberate
      //      slider / +/- adjustment the user made during the muted period;
      //      that adjustment has already invalidated the snapshot via the
      //      storage-sync listener, so we honour it here instead of
      //      overwriting it with an arbitrary default).
      //   3. VOLUME_DEFAULT, terminal fallback when nothing is meaningful.
      const restoreVol = hasVolSave && data.volumeBeforeMute > 0
        ? data.volumeBeforeMute
        : (Number.isFinite(data.volumeMultiplier) && data.volumeMultiplier > 0
          ? data.volumeMultiplier
          : VOLUME_DEFAULT);
      const restoreBreath = hasBreathSave ? data.breathingBeforeMute : true;

      chrome.storage.local.set({
        soundEnabled: true,
        volumeMultiplier: restoreVol,
        breathingEnabled: restoreBreath
      }, () => {
        chrome.storage.local.remove(
          ['volumeBeforeMute', 'breathingBeforeMute'],
          resolve
        );
      });
    });
  }

  /**
   * Explicit mute. Used by the popup checkbox when unticked.
   */
  async function applyMute() {
    const data = await _readSnapshot();
    return _writeMute(data);
  }

  /**
   * Explicit unmute. Used by the popup checkbox when ticked.
   */
  async function applyUnmute() {
    const data = await _readSnapshot();
    return _writeUnmute(data);
  }

  /**
   * Decide-and-apply: used by the M hotkey.
   *
   * Truth table:
   *   currently unmuted (sound on)               → mute
   *   muted, snapshot present (volumeBeforeMute) → unmute (restore)
   *   muted, snapshot absent (post-invalidation) → re-mute (refresh)
   *
   * The "muted, no snapshot" branch is the spec's "after the user moves the
   * slider during a mute, the next M re-mutes instead of restoring".
   */
  async function toggle() {
    const data = await _readSnapshot();
    const muted = data.soundEnabled === false;
    const hasVolSave = Number.isFinite(data.volumeBeforeMute);
    if (muted && hasVolSave) return _writeUnmute(data);
    return _writeMute(data);
  }

  /**
   * Predicate for the storage-sync listener: distinguishes our own mute /
   * unmute writes from a single-axis user touch (slider drag, breath
   * button click, popup-only-soundEnabled, ...).
   *
   *   Branch 1 — snapshot keys appear in changes:
   *     Only _writeMute writes volumeBeforeMute / breathingBeforeMute, so
   *     their presence in changes is a univocal "this is a mute op" marker.
   *     This branch is what catches the edge case in which only one audio
   *     axis differs from the muted target (e.g. user already had vol=0:
   *     applyMute scrubs nothing on volumeMultiplier and only soundEnabled
   *     ends up in changes alongside the snapshot keys). A naive "count
   *     axes" heuristic misses this case and would invalidate the freshly
   *     written snapshot.
   *
   *   Branch 2 — all three audio axes change together:
   *     _writeUnmute writes only the three audio axes (the snapshot remove
   *     happens in a separate onChanged event). All three changing at once
   *     is the unmute fingerprint.
   */
  function isMuteOperationChange(changes) {
    if (!changes) return false;
    if (changes.volumeBeforeMute !== undefined) return true;
    if (changes.breathingBeforeMute !== undefined) return true;
    return changes.soundEnabled !== undefined
      && changes.volumeMultiplier !== undefined
      && changes.breathingEnabled !== undefined;
  }

  root.mute = Object.freeze({
    applyMute,
    applyUnmute,
    toggle,
    isMuteOperationChange
  });
})();
