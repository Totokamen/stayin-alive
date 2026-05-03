/*
 * Stayin' Alive - Audio feedback for Lichess chess clocks
 * Copyright (C) 2026 LBSoft
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

document.addEventListener('DOMContentLoaded', () => {
  const soundToggle = document.getElementById('sound-toggle');
  const versionEl = document.getElementById('sa-version');

  if (versionEl && chrome.runtime?.getManifest) {
    const version = chrome.runtime.getManifest().version;
    versionEl.textContent = `v${version} by LBSoft`;
  }

  chrome.storage.local.get(['soundEnabled'], (data) => {
    soundToggle.checked = data.soundEnabled !== undefined ? data.soundEnabled : true;
  });

  // Keep the checkbox in sync if another surface (M hotkey, overlay, second
  // tab) flips soundEnabled while the popup is open.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.soundEnabled) {
      soundToggle.checked = !!changes.soundEnabled.newValue;
    }
  });

  // Delegate to the shared true-mute API so the checkbox uses the same state
  // machine as the M hotkey: tick = full unmute (restore from snapshot if
  // available, sane defaults otherwise); untick = full mute (zero all three
  // audio axes and save the snapshot).
  soundToggle.addEventListener('change', () => {
    const mute = window.STAYIN_ALIVE && window.STAYIN_ALIVE.mute;
    if (!mute) {
      // Fallback in case sa.mute.js failed to load: legacy partial behaviour
      // is better than no behaviour at all.
      chrome.storage.local.set({ soundEnabled: soundToggle.checked });
      return;
    }
    if (soundToggle.checked) mute.applyUnmute();
    else mute.applyMute();
  });
});
