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

(() => {
  'use strict';

  const VERSION = '2.3.5';
  const POLL_FAST = 100;            // ms, during a game
  const POLL_SLOW = 1000;           // ms, elsewhere on Lichess
  const BPM_MIN = 40;
  const BPM_MAX = 180;
  const RESULT_DELAY_MS = 1000;     // wait before playing the result jingle
  const CRITICAL_THRESHOLD = 5;     // seconds, triggers urgent beeps
  const VOLUME_MIN = 0;
  const VOLUME_MAX = 2;             // 200% max, per user request
  const VOLUME_DEFAULT = 1;         // 100%, the baseline mix
  const VOLUME_STEP = 0.05;         // ± step for +/- hotkeys, 5 %
  const DRAG_THRESHOLD = 4;         // px, min pointer movement to count as drag

  // =============================================
  //  STATE
  // =============================================

  const state = {
    active: false,
    soundEnabled: true,               // master audio toggle (from popup)
    breathingEnabled: true,           // breathing-only toggle (from overlay button)
    volumeMultiplier: VOLUME_DEFAULT, // master gain multiplier, 0..2
    collapsed: false,                 // mini mode (just the heart glyph); persisted
    panicked: false,                  // Space-bar panic mute; volatile, resets at game end
    totalTime: 0,                   // 0 = not yet initialized
    myTime: null,
    opponentTime: null,
    bpm: BPM_MIN,
    overlayPosition: { x: 20, y: 20 },
    username: null
  };

  // Cached DOM references (cleared between games)
  const dom = {
    myClockEl: null,
    oppClockEl: null,
    myClockPos: null,               // 'top' | 'bottom'
    bpmEl: null                     // value inside overlay
  };

  // Audio
  let audioCtx = null;
  let audioUnlocked = false;
  let noiseBuffer = null;
  let masterGain = null;            // all audio routed through this for volume control

  let heartbeatTimeout = null;
  let criticalBeepTimeout = null;
  let breathing = null;             // { source, gain, filter, lfo, lfoGain } | null

  // Polling
  let pollInterval = null;
  let currentPollRate = POLL_SLOW;
  let lastUrl = location.href;

  // Overlay
  let overlay = null;
  let overlayAbort = null;          // AbortController for overlay listeners
  let needsDefaultPosition = false; // true until board-relative default placed
  let nudgeTimeout = null;          // hides the numeric readout after a +/- nudge

  // M-hotkey mute bookkeeping
  //   muteRestoreValid: true right after toggleMute, flipped to false the
  //     moment the user touches any of the three muted properties (volume,
  //     sound, breath). This is what distinguishes "press M to undo the
  //     previous M" from "press M to re-mute because I just moved the slider".
  //   muteOpInFlight: set to true for the duration of our own storage write
  //     so the onChanged listener doesn't mistake our mute for a user action
  //     and invalidate itself.
  let muteRestoreValid = false;
  let muteOpInFlight = false;

  // End-of-game handling
  let resultSoundPlayed = false;
  let gameOverDetectedAt = 0;
  // True only if isGameRunning() has been true at least once in the current
  // session (i.e. we actually witnessed the live game). Stays false when we
  // land on a page whose game is already over (fresh tab, hard reload, SPA
  // nav to a finished game), so we don't replay the result jingle every time
  // the user revisits a completed game.
  let liveGameObserved = false;

  // =============================================
  //  UTILITIES
  // =============================================

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function resetGameCache() {
    dom.myClockEl = null;
    dom.oppClockEl = null;
    dom.myClockPos = null;
    state.totalTime = 0;
    state.myTime = null;
    state.opponentTime = null;
    resultSoundPlayed = false;
    gameOverDetectedAt = 0;
    liveGameObserved = false;
  }

  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (state.active) {
      state.active = false;
      stopAllSounds();
    }
    resetGameCache();
    removeOverlay();
  }

  function setPollRate(rate) {
    if (rate === currentPollRate) return;
    if (pollInterval) clearInterval(pollInterval);
    currentPollRate = rate;
    pollInterval = setInterval(pollGameState, rate);
  }

  // =============================================
  //  AUDIO CORE
  // =============================================

  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      ensureAudioContext();
      audioUnlocked = true;
    } catch (e) { /* ignore */ }
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Master gain node: every oscillator/buffer source connects here instead
      // of audioCtx.destination, so adjusting volumeMultiplier attenuates the
      // whole mix in one place.
      masterGain = audioCtx.createGain();
      masterGain.gain.value = state.volumeMultiplier;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  const isAudioReady = () =>
    audioUnlocked && audioCtx && audioCtx.state === 'running';

  /**
   * Smoothly ramps the master gain to the current volumeMultiplier. Short
   * ramp (50 ms) prevents zippering while still feeling responsive during
   * slider drags.
   */
  function applyMasterVolume() {
    if (!masterGain || !audioCtx) return;
    const now = audioCtx.currentTime;
    try {
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(state.volumeMultiplier, now + 0.05);
    } catch (e) { /* ignore */ }
  }

  /**
   * Schedules a single tone. Unified helper used by heartbeat, critical beep
   * and result jingles.
   */
  function playTone(freq, start, duration, peakVol, opts = {}) {
    const { type = 'sine', attack = 0.03, decay = 'exp' } = opts;
    try {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(peakVol, start + attack);
      if (decay === 'exp') {
        g.gain.exponentialRampToValueAtTime(0.001, start + duration);
      } else {
        g.gain.linearRampToValueAtTime(0, start + duration);
      }
      osc.connect(g).connect(masterGain || audioCtx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    } catch (e) { /* audio node failure, ignore */ }
  }

  /**
   * Schedules a smooth ramp on an AudioParam, cancelling any pending events
   * so we don't accumulate them at 10 Hz.
   */
  function rampParam(param, target, now, at) {
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, at);
    } catch (e) { /* ignore */ }
  }

  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const size = audioCtx.sampleRate * 2;
    noiseBuffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  // =============================================
  //  CLOCK READING & GAME DETECTION
  // =============================================

  function parseClockText(text) {
    const s = text.trim();
    const parts = s.split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const sec = parseFloat(parts[1]);
      if (isNaN(m) || isNaN(sec)) return NaN;
      return m * 60 + sec;
    }
    return parseFloat(s);
  }

  function detectUsername() {
    if (state.username) return state.username;
    const tag = document.getElementById('user_tag');
    if (tag) {
      state.username = tag.textContent.trim();
      return state.username;
    }
    for (const link of document.querySelectorAll('.site-buttons a[href^="/@/"]')) {
      const name = link.textContent.trim();
      if (name && name !== 'Profile') {
        state.username = name;
        return name;
      }
    }
    return null;
  }

  function findMyClockPosition() {
    if (dom.myClockPos) return dom.myClockPos;
    const username = detectUsername();
    if (!username) return 'bottom';
    const bottom = document.querySelector('.ruser-bottom .user-link')?.textContent?.trim();
    if (bottom?.includes(username)) { dom.myClockPos = 'bottom'; return 'bottom'; }
    const top = document.querySelector('.ruser-top .user-link')?.textContent?.trim();
    if (top?.includes(username)) { dom.myClockPos = 'top'; return 'top'; }
    return 'bottom';
  }

  function readClocks() {
    // Re-cache if refs were never set or got detached (Lichess re-renders)
    const stale = !dom.myClockEl || !dom.oppClockEl
      || !document.contains(dom.myClockEl) || !document.contains(dom.oppClockEl);

    if (stale) {
      const myPos = findMyClockPosition();
      const oppPos = myPos === 'bottom' ? 'top' : 'bottom';
      dom.myClockEl = document.querySelector(`.rclock-${myPos} .time`);
      dom.oppClockEl = document.querySelector(`.rclock-${oppPos} .time`);
    }

    if (!dom.myClockEl || !dom.oppClockEl) return null;
    const my = parseClockText(dom.myClockEl.textContent);
    const opp = parseClockText(dom.oppClockEl.textContent);
    return (isNaN(my) || isNaN(opp)) ? null : { myTime: my, opponentTime: opp };
  }

  function isGamePage() {
    // Fast URL check, then DOM check
    if (!/lichess\.org\/\w{8,}/.test(location.href)) return false;
    return document.querySelector('.rclock') !== null;
  }

  function isGameOver() {
    return document.querySelector('.result-wrap') !== null;
  }

  /**
   * Returns true while the game is live.
   *
   * NOTE: we deliberately do NOT try to detect "someone is thinking" via
   * clock stagnation. Lichess only displays decimals under ~10 seconds;
   * above that the textContent can stay identical for several seconds
   * during a long think, and a stagnation-based check would silence the
   * sounds exactly when pressure is highest. Instead we rely on the
   * presence of `.rclock` and the absence of `.result-wrap`.
   */
  function isGameRunning() {
    if (isGameOver()) return false;
    return dom.myClockEl !== null && dom.oppClockEl !== null;
  }

  function detectTimeControlFromPage() {
    const el = document.querySelector('.setup');
    if (!el) return 0;
    const match = el.textContent.match(/(\d+)\+(\d+)/);
    return match ? parseInt(match[1], 10) * 60 : 0;
  }

  /**
   * Sets state.totalTime from the page when possible, else falls back to the
   * first valid clock reading. This keeps urgency curves sensible even if we
   * loaded the page mid-game or Lichess changes the `.setup` markup.
   */
  function ensureTotalTime() {
    if (state.totalTime > 0) return;
    const fromPage = detectTimeControlFromPage();
    if (fromPage > 0) { state.totalTime = fromPage; return; }
    if (typeof state.myTime === 'number' && state.myTime > 0) {
      state.totalTime = state.myTime;
    }
  }

  // =============================================
  //  URGENCY & BPM
  // =============================================

  function getTimeUrgency() {
    if (!state.totalTime || typeof state.myTime !== 'number') return 0;
    return clamp(1 - (state.myTime / state.totalTime), 0, 1);
  }

  function getAdvantageRatio() {
    const my = typeof state.myTime === 'number' ? state.myTime : 0;
    const opp = typeof state.opponentTime === 'number' ? state.opponentTime : 0.1;
    return my / Math.max(opp, 0.1);
  }

  function calculateBPM(myTime, oppTime) {
    const ratio = Math.max(myTime, 0.1) / Math.max(oppTime, 0.1);
    const pressure = (1.6 - clamp(Math.log2(ratio), -1.6, 1.6)) / 3.2;
    return Math.round(BPM_MIN + pressure * (BPM_MAX - BPM_MIN));
  }

  // =============================================
  //  HEARTBEAT (BPM = ratio, volume = absolute time)
  // =============================================

  function playHeartbeatPulse() {
    if (!isAudioReady()) return;
    const now = audioCtx.currentTime;
    const urgency = getTimeUrgency();
    const vol = 0.15 + urgency * urgency * 0.65;
    playTone(55, now,        0.15, vol);         // Lub
    playTone(75, now + 0.12, 0.10, vol * 0.6);   // Dub
  }

  function scheduleHeartbeat() {
    if (!state.soundEnabled || !state.active || state.panicked) return;
    playHeartbeatPulse();
    heartbeatTimeout = setTimeout(scheduleHeartbeat, 60000 / state.bpm);
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (state.soundEnabled && state.active && !state.panicked) scheduleHeartbeat();
  }

  function stopHeartbeat() {
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  }

  // =============================================
  //  BREATHING (organic rhythmic whoosh)
  // =============================================

  function startBreathing() {
    if (breathing || !state.soundEnabled || !state.breathingEnabled || !state.active || state.panicked || !isAudioReady()) return;
    try {
      const now = audioCtx.currentTime;

      const source = audioCtx.createBufferSource();
      source.buffer = getNoiseBuffer();
      source.loop = true;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(300, now);
      filter.Q.value = 1.5;

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);

      const lfo = audioCtx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.12, now);

      const lfoGain = audioCtx.createGain();
      lfoGain.gain.setValueAtTime(0, now);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain || audioCtx.destination);
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);

      source.start();
      lfo.start();

      breathing = { source, gain, filter, lfo, lfoGain };
    } catch (e) {
      stopBreathing();
    }
  }

  function updateBreathing() {
    if (!breathing || !audioCtx) return;
    const { gain, filter, lfo, lfoGain } = breathing;
    const now = audioCtx.currentTime;
    const t = now + 0.5;
    const urgency = getTimeUrgency();
    const ratio = getAdvantageRatio();

    const rate = 0.12 + urgency * urgency * 0.58;

    // Cubic volume curve on urgency
    let vol = urgency * urgency * urgency * 0.12;

    // Attenuate when the player is way ahead on the clock
    if (ratio >= 4)      vol *= 0.05;
    else if (ratio >= 3) vol *= 0.50;
    else if (ratio > 2)  vol *= 0.75;

    const filterFreq = 300 + urgency * 400;

    // LFO amplitude = 85% of target → modulated gain swings between
    // 15% and 185% of the intended volume (never fully silent).
    const lfoDepth = vol * 0.85;

    rampParam(lfo.frequency, rate, now, t);
    rampParam(lfoGain.gain, lfoDepth, now, t);
    rampParam(gain.gain, vol, now, t);
    rampParam(filter.frequency, filterFreq, now, t);
  }

  function stopBreathing() {
    if (!breathing) return;
    const { source, lfo, lfoGain, filter, gain } = breathing;
    try { source.stop(); } catch (e) { /* */ }
    try { lfo.stop(); } catch (e) { /* */ }
    [source, lfo, lfoGain, filter, gain].forEach(n => {
      try { n.disconnect(); } catch (e) { /* */ }
    });
    breathing = null;
  }

  // =============================================
  //  CRITICAL BEEP (under 5 seconds)
  // =============================================

  function playCriticalBeep(freq) {
    if (!isAudioReady()) return;
    playTone(freq, audioCtx.currentTime, 0.07, 0.10, {
      type: 'square', attack: 0.01, decay: 'lin'
    });
  }

  function scheduleCriticalBeep() {
    if (!state.active || !state.soundEnabled) { stopCriticalBeep(); return; }
    const my = typeof state.myTime === 'number' ? state.myTime : Infinity;
    const opp = typeof state.opponentTime === 'number' ? state.opponentTime : Infinity;
    const myCrit = my <= CRITICAL_THRESHOLD;
    const oppCrit = opp <= CRITICAL_THRESHOLD;

    if (!myCrit && !oppCrit) { stopCriticalBeep(); return; }

    if (myCrit) {
      // My time is critical: high pitch, faster as time shrinks
      playCriticalBeep(880);
      criticalBeepTimeout = setTimeout(scheduleCriticalBeep,
        120 + (my / CRITICAL_THRESHOLD) * 80);
    } else {
      // Opponent's time is critical: lower pitch, slower
      playCriticalBeep(330);
      criticalBeepTimeout = setTimeout(scheduleCriticalBeep,
        200 + (opp / CRITICAL_THRESHOLD) * 150);
    }
  }

  function startCriticalBeep() {
    if (!criticalBeepTimeout) scheduleCriticalBeep();
  }

  function stopCriticalBeep() {
    if (criticalBeepTimeout) { clearTimeout(criticalBeepTimeout); criticalBeepTimeout = null; }
  }

  // =============================================
  //  RESULT SOUNDS
  // =============================================

  function playVictorySound() {
    if (!isAudioReady()) return;
    const now = audioCtx.currentTime;
    // Do–Mi–Sol, last note held (ratio 1-1-4)
    const u = 0.22;
    playTone(523, now,         u,     0.25);
    playTone(659, now + u,     u,     0.25);
    playTone(784, now + u * 2, u * 4, 0.28);
  }

  function playDefeatSound() {
    if (!isAudioReady()) return;
    const now = audioCtx.currentTime;
    // Sol-Sol-Sol-Mi♭, last note held (ratio 1-1-1-3)
    const u = 0.2;
    playTone(392, now,         u,     0.20);
    playTone(392, now + u,     u,     0.20);
    playTone(392, now + u * 2, u,     0.20);
    playTone(311, now + u * 3, u * 3, 0.17);
  }

  function playDrawSound() {
    if (!isAudioReady()) return;
    const now = audioCtx.currentTime;
    // Sol2-Sol2-Sol2, last note held (ratio 1-1-2)
    const u = 0.28;
    playTone(196, now,         u,     0.19);
    playTone(196, now + u,     u,     0.19);
    playTone(196, now + u * 2, u * 2, 0.19);
  }

  function detectGameResult() {
    const el = document.querySelector('.result-wrap .result');
    if (!el) return null;
    const result = el.textContent.trim();
    if (result === '½-½') return 'draw';

    const username = detectUsername();
    if (!username) return null;

    let userIsWhite = null;
    for (const p of document.querySelectorAll('.player')) {
      if (p.textContent.includes(username)) {
        userIsWhite = p.classList.contains('white');
        break;
      }
    }
    if (userIsWhite === null) return null;

    if (result === '1-0') return userIsWhite ? 'win' : 'loss';
    if (result === '0-1') return userIsWhite ? 'loss' : 'win';
    return null;
  }

  function playResultSound(result) {
    if (result === 'win')  playVictorySound();
    if (result === 'loss') playDefeatSound();
    if (result === 'draw') playDrawSound();
  }

  function handleGameOver() {
    if (resultSoundPlayed || !state.soundEnabled) return;
    // Don't play the result jingle if we never observed the live game this
    // session — landing on a page that's already showing `.result-wrap`
    // (reload, SPA navigation, fresh tab) should stay silent. Otherwise a
    // quick keypress right after reload races the audio-unlock against
    // handleGameOver's delay and fires the jingle out of context.
    if (!liveGameObserved) return;
    if (!isGameOver()) return;
    if (gameOverDetectedAt === 0) gameOverDetectedAt = Date.now();
    if (Date.now() - gameOverDetectedAt < RESULT_DELAY_MS) return;
    const result = detectGameResult();
    if (result) {
      playResultSound(result);
      resultSoundPlayed = true;
    }
  }

  // =============================================
  //  SOUND CONTROL
  // =============================================

  function stopAllSounds() {
    stopHeartbeat();
    stopBreathing();
    stopCriticalBeep();
  }

  /**
   * Single source of truth for toggling sound. Updates state and restarts or
   * stops the audio pipelines. The popup owns the UI for this toggle.
   */
  function setSoundEnabled(enabled) {
    if (state.soundEnabled === enabled) return;
    state.soundEnabled = enabled;
    if (enabled && state.active) {
      startHeartbeat();
      startBreathing();
    } else {
      stopAllSounds();
    }
  }

  /**
   * Toggles ONLY the breathing layer. Heartbeat, critical beeps and result
   * jingles keep playing. Driven by the small coloured button in the overlay
   * header (green = breath on, grey = breath off).
   */
  function setBreathingEnabled(enabled) {
    if (state.breathingEnabled === enabled) return;
    state.breathingEnabled = enabled;
    if (enabled && state.soundEnabled && state.active) {
      startBreathing();
    } else {
      stopBreathing();
    }
    if (overlay) {
      const btn = overlay.querySelector('.sa-toggle');
      if (btn) {
        btn.classList.toggle('sa-off', !enabled);
        btn.title = enabled ? 'Breath on' : 'Breath off';
      }
    }
  }

  /**
   * Panic mute: silences heartbeat + breathing while keeping critical beeps
   * and result jingles active. Volatile state, not persisted, auto-resets at
   * game end. Triggered by the Space bar hotkey.
   */
  function setPanicMode(enabled) {
    if (state.panicked === enabled) return;
    state.panicked = enabled;
    if (enabled) {
      stopHeartbeat();
      stopBreathing();
    } else if (state.soundEnabled && state.active) {
      startHeartbeat();
      if (state.breathingEnabled) startBreathing();
    }
    if (overlay) overlay.classList.toggle('sa-panic', enabled);
  }

  /**
   * Mini mode: collapses the overlay to just a pulsing heart glyph. Click
   * on the title heart collapses, click on the collapsed heart re-expands.
   * Persisted to storage so the choice survives page reload.
   */
  function setCollapsed(value) {
    const v = !!value;
    if (state.collapsed === v) return;
    state.collapsed = v;
    if (overlay) overlay.classList.toggle('sa-collapsed', v);
    chrome.storage.local.set({ collapsed: v });
  }

  /**
   * Nudges the master volume by ±VOLUME_STEP, clamped to [MIN..MAX]. Used
   * by the +/- hotkeys; writes the new value back to storage so the slider
   * UI and onChanged listener stay in sync. A transient `.sa-nudged` class
   * on the cursor reveals the numeric readout for a moment, mirroring the
   * bubble that appears during a mouse drag.
   */
  function adjustVolume(delta) {
    const next = clamp(state.volumeMultiplier + delta, VOLUME_MIN, VOLUME_MAX);
    if (next === state.volumeMultiplier) return;
    state.volumeMultiplier = next;
    applyMasterVolume();
    setVolumeCursorPosition(next);
    chrome.storage.local.set({ volumeMultiplier: next });

    if (overlay) {
      const cursor = overlay.querySelector('.sa-volume-cursor');
      if (cursor) {
        cursor.classList.add('sa-nudged');
        if (nudgeTimeout) clearTimeout(nudgeTimeout);
        nudgeTimeout = setTimeout(() => {
          cursor.classList.remove('sa-nudged');
          nudgeTimeout = null;
        }, 700);
      }
    }
  }

  /**
   * True mute/unmute for the M hotkey. Muting forces all three "audible
   * axes" off at once: master sound, volume, and breathing toggle. The
   * overlay slider drops to zero AND the breath button goes grey. Unmuting
   * restores all three from the saved snapshot.
   *
   * Snapshot policy:
   *   - volumeBeforeMute refreshes with the latest audible value each time
   *     the user re-mutes after moving the slider, so restore returns to
   *     the NEW audible volume, not the stale one.
   *   - breathingBeforeMute is STICKY: once captured on the first mute it
   *     survives re-mutes, so the restore always returns the breath button
   *     to the state the user originally chose, not the OFF we forced.
   *
   * Restore gate:
   *   muteRestoreValid tracks whether anything changed since the last M
   *   press. Set true at the end of every toggleMute; flipped to false in
   *   the storage.onChanged listener whenever the user touches vol / sound
   *   / breath via the popup, slider, breath button, H, +/-, etc. If it's
   *   false when M is pressed, we treat that press as a FRESH MUTE instead
   *   of a restore — matching the spec "any interaction between two M
   *   presses cancels the restore and re-mutes everything".
   */
  function toggleMute() {
    chrome.storage.local.get(['volumeBeforeMute', 'breathingBeforeMute'], (data) => {
      const hasSave = Number.isFinite(data.volumeBeforeMute);
      const canRestore = muteRestoreValid && hasSave;

      muteOpInFlight = true;

      if (canRestore) {
        const restoreVol = data.volumeBeforeMute > 0
          ? data.volumeBeforeMute
          : VOLUME_DEFAULT;
        const restoreBreath = typeof data.breathingBeforeMute === 'boolean'
          ? data.breathingBeforeMute
          : true;
        chrome.storage.local.set({
          soundEnabled: true,
          volumeMultiplier: restoreVol,
          breathingEnabled: restoreBreath
        });
        chrome.storage.local.remove(['volumeBeforeMute', 'breathingBeforeMute']);
      } else {
        // Fresh mute. Volume snapshot refreshes with the current audible
        // value (fallback to the previous save if we're somehow at zero,
        // else default, so restore always lands on something audible).
        // Breath snapshot is sticky: keep the existing one if we have it.
        const saveVol = state.volumeMultiplier > 0
          ? state.volumeMultiplier
          : (hasSave && data.volumeBeforeMute > 0 ? data.volumeBeforeMute : VOLUME_DEFAULT);
        const saveBreath = (hasSave && typeof data.breathingBeforeMute === 'boolean')
          ? data.breathingBeforeMute
          : state.breathingEnabled;
        chrome.storage.local.set({
          volumeBeforeMute: saveVol,
          breathingBeforeMute: saveBreath,
          soundEnabled: false,
          volumeMultiplier: 0,
          breathingEnabled: false
        });
      }

      muteRestoreValid = true;
    });
  }

  // =============================================
  //  OVERLAY
  // =============================================

  const BOARD_SELECTORS = '.round__app__board, .main-board, cg-wrap, .cg-wrap';
  const THEME_SOURCE_SELECTORS = '.round__side, .game__meta, main';
  const OVERLAY_GAP = 8;            // px between overlay and board edge

  /**
   * Reads the current Lichess theme colours from the game side panel and
   * applies them as CSS custom properties on the overlay, so the overlay
   * blends with whatever skin the user has active instead of being locked
   * to a hardcoded dark grey.
   */
  function applyLichessTheme() {
    if (!overlay) return;
    const source = document.querySelector(THEME_SOURCE_SELECTORS) || document.body;

    // Walk up the tree until we find a non-transparent background; panels
    // often inherit their background from a parent.
    let bg = null;
    for (let el = source; el && el !== document.documentElement; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break; }
    }

    const fg = getComputedStyle(source).color;

    if (bg) overlay.style.setProperty('--sa-bg', bg);
    if (fg) overlay.style.setProperty('--sa-fg', fg);
  }

  function constrainToViewport(x, y) {
    const w = overlay ? overlay.offsetWidth : 130;
    const h = overlay ? overlay.offsetHeight : 80;
    return {
      x: clamp(x, 0, Math.max(0, window.innerWidth - w)),
      y: clamp(y, 0, Math.max(0, window.innerHeight - h))
    };
  }

  /**
   * Default overlay position: just to the left of the board, aligned with its
   * top edge. All values in viewport coordinates since the overlay uses
   * `position: fixed`. Returns null if the board isn't laid out yet.
   */
  function computeDefaultPosition() {
    const board = document.querySelector(BOARD_SELECTORS);
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const overlayW = overlay?.offsetWidth || 130;
    return {
      x: Math.round(rect.left - overlayW - OVERLAY_GAP),
      y: Math.round(rect.top)
    };
  }

  function applyPosition(pos) {
    if (!overlay) return;
    const c = constrainToViewport(pos.x, pos.y);
    overlay.style.left = c.x + 'px';
    overlay.style.top = c.y + 'px';
    overlay.style.visibility = 'visible';
    state.overlayPosition = c;
  }

  function tryApplyDefaultPosition() {
    if (!needsDefaultPosition || !overlay) return;
    const pos = computeDefaultPosition();
    if (pos) {
      applyPosition(pos);
      needsDefaultPosition = false;
    } else if (overlay.style.visibility === 'hidden') {
      // Board not ready: show at a safe temporary spot, keep the flag set
      // so we retry on the next poll tick.
      applyPosition({ x: 20, y: 80 });
    }
  }

  /**
   * Converts a pointer Y coordinate to a volume multiplier by mapping it
   * across the track's bounding box. Top of track = VOLUME_MAX, bottom = 0.
   */
  function multiplierFromClientY(trackEl, clientY) {
    const rect = trackEl.getBoundingClientRect();
    if (!rect.height) return state.volumeMultiplier;
    const y = clamp(clientY - rect.top, 0, rect.height);
    const frac = y / rect.height;            // 0 at top, 1 at bottom
    return clamp((1 - frac) * VOLUME_MAX, VOLUME_MIN, VOLUME_MAX);
  }

  /**
   * Moves the slider cursor to reflect the given multiplier and updates the
   * readout text. Cursor centre sits at top:(1 - m/2)*100% of the track.
   */
  function setVolumeCursorPosition(multiplier) {
    if (!overlay) return;
    const cursor = overlay.querySelector('.sa-volume-cursor');
    const readout = overlay.querySelector('.sa-volume-readout');
    if (!cursor) return;
    const frac = 1 - multiplier / VOLUME_MAX;
    cursor.style.top = (frac * 100) + '%';
    if (readout) readout.textContent = Math.round(multiplier * 100) + '%';
  }

  /**
   * Snaps a free-range multiplier (0..2) to the closest of the three tick
   * values: min/default/max. Used for track clicks so the three tacche act
   * as magnets.
   */
  function snapToTick(multiplier) {
    const ticks = [VOLUME_MIN, VOLUME_DEFAULT, VOLUME_MAX];
    let best = ticks[0], bestD = Infinity;
    for (const t of ticks) {
      const d = Math.abs(multiplier - t);
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'stayin-alive-overlay';
    overlay.style.visibility = 'hidden'; // hidden until positioned (no flash at 0,0)
    overlay.innerHTML = `
      <div class="sa-collapsed-heart sa-drag-handle" title="Expand">\u2665</div>
      <div class="sa-header sa-drag-handle">
        <div class="sa-title-zone">
          <span class="sa-title"><span class="sa-heart" title="Collapse">\u2665</span> Stayin' Alive</span>
        </div>
        <div class="sa-toggle-zone">
          <button class="sa-toggle${state.breathingEnabled ? '' : ' sa-off'}" aria-label="Toggle breathing sound" title="${state.breathingEnabled ? 'Breath on' : 'Breath off'}"></button>
        </div>
      </div>
      <div class="sa-body">
        <div class="sa-content">
          <div class="sa-bpm">
            <span class="sa-bpm-value">${state.bpm}</span>
            <span class="sa-bpm-label">BPM</span>
          </div>
          <div class="sa-version">v${VERSION} by LBSoft</div>
        </div>
        <div class="sa-volume" title="Volume">
          <div class="sa-volume-track">
            <div class="sa-tick sa-tick-max"></div>
            <div class="sa-tick sa-tick-default"></div>
            <div class="sa-tick sa-tick-min"></div>
            <div class="sa-volume-cursor" title="Drag to change volume, double-click to reset to 100%">
              <span class="sa-volume-readout">100%</span>
            </div>
          </div>
        </div>
      </div>
    `;
    if (state.collapsed) overlay.classList.add('sa-collapsed');
    if (state.panicked) overlay.classList.add('sa-panic');
    document.body.appendChild(overlay);
    dom.bpmEl = overlay.querySelector('.sa-bpm-value');
    applyLichessTheme();
    setVolumeCursorPosition(state.volumeMultiplier);

    needsDefaultPosition = false;

    // Restore saved position if any; otherwise place the overlay relative to
    // the board's top-left corner (see computeDefaultPosition).
    chrome.storage.local.get('overlayPosition', (data) => {
      if (!overlay) return; // overlay destroyed before callback fired
      if (data.overlayPosition) {
        applyPosition(data.overlayPosition);
      } else {
        needsDefaultPosition = true;
        tryApplyDefaultPosition();
      }
    });

    // All listeners share one AbortController so they're cleaned up together
    // when the overlay is removed (prevents leaks on SPA navigation).
    overlayAbort = new AbortController();
    const { signal } = overlayAbort;

    const toggleBtn = overlay.querySelector('.sa-toggle');

    // Drag is wired to every element carrying `.sa-drag-handle`: the expanded
    // header AND the collapsed heart. A tiny movement threshold distinguishes
    // a real drag (commit new position) from a click on the collapsed heart
    // (re-expand the overlay) so we don't need two separate gesture systems.
    function wireDragHandle(handleEl) {
      let dragging = false, dragX = 0, dragY = 0, downX = 0, downY = 0, moved = false;

      handleEl.addEventListener('pointerdown', (e) => {
        // Let internal controls handle their own clicks without hijacking them.
        if (e.target.closest('.sa-toggle') || e.target.closest('.sa-heart')) return;
        dragging = true;
        moved = false;
        downX = e.clientX;
        downY = e.clientY;
        dragX = e.clientX - overlay.offsetLeft;
        dragY = e.clientY - overlay.offsetTop;
        try { handleEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
      }, { signal });

      handleEl.addEventListener('pointermove', (e) => {
        if (!dragging || !overlay) return;
        if (!moved &&
            (Math.abs(e.clientX - downX) > DRAG_THRESHOLD ||
             Math.abs(e.clientY - downY) > DRAG_THRESHOLD)) {
          moved = true;
        }
        if (!moved) return;
        const pos = constrainToViewport(e.clientX - dragX, e.clientY - dragY);
        overlay.style.left = pos.x + 'px';
        overlay.style.top = pos.y + 'px';
      }, { signal });

      const endDrag = (e) => {
        if (!dragging || !overlay) return;
        dragging = false;
        try { handleEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (moved) {
          state.overlayPosition = { x: overlay.offsetLeft, y: overlay.offsetTop };
          needsDefaultPosition = false;
          chrome.storage.local.set({ overlayPosition: state.overlayPosition });
        } else if (handleEl.classList.contains('sa-collapsed-heart')) {
          // Click without movement on the collapsed heart re-expands.
          setCollapsed(false);
        }
      };

      handleEl.addEventListener('pointerup', endDrag, { signal });
      handleEl.addEventListener('pointercancel', endDrag, { signal });
    }

    overlay.querySelectorAll('.sa-drag-handle').forEach(wireDragHandle);

    // Click on the title heart → collapse to mini mode. The drag handler
    // above already bails out when the pointerdown target is .sa-heart, so
    // a bare click fires cleanly here.
    const titleHeart = overlay.querySelector('.sa-header .sa-heart');
    if (titleHeart) {
      titleHeart.addEventListener('click', (e) => {
        e.stopPropagation();
        setCollapsed(true);
      }, { signal });
    }

    // Re-clamp the overlay to the viewport if the window is resized
    // (otherwise a position saved with a wide window leaves the overlay
    // off-screen after shrinking the browser).
    window.addEventListener('resize', () => {
      if (overlay && state.overlayPosition) applyPosition(state.overlayPosition);
    }, { signal });

    // Breathing toggle. Writes to storage; the onChanged listener applies
    // the new state everywhere (keeps multiple tabs in sync too).
    // We immediately blur() so the button doesn't keep keyboard focus: a
    // focused <button> treats the Space bar as a synthetic click, which
    // would hijack our Space = panic hotkey right after any mouse click.
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ breathingEnabled: !state.breathingEnabled });
      toggleBtn.blur();
    }, { signal });

    // -----------------------------------------------------------------
    //  Volume slider
    //
    //  Click on the empty track → snap to the nearest tick (min / default /
    //  max act as magnets). Pointerdown on the cursor → start a free drag
    //  (0..200 %). Double-click on the cursor → reset to 100 %.
    //
    //  We intentionally do NOT use setPointerCapture: on Chromium it can
    //  suppress the synthesized click/dblclick events, which breaks the
    //  double-click-to-reset gesture. Instead the drag uses window-level
    //  pointermove/pointerup so it keeps working if the pointer drifts off
    //  the track, without interfering with click generation.
    // -----------------------------------------------------------------
    const volTrack = overlay.querySelector('.sa-volume-track');
    const volCursor = overlay.querySelector('.sa-volume-cursor');
    let volDragging = false;

    const commitVolume = (m) => {
      state.volumeMultiplier = m;
      setVolumeCursorPosition(m);
      applyMasterVolume();
    };

    volTrack.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // don't let the overlay header drag react
      if (e.target.closest('.sa-volume-cursor')) {
        // Grab the cursor → free drag
        volDragging = true;
        volCursor.classList.add('sa-dragging');
      } else {
        // Empty track → snap to nearest tick, no drag
        const raw = multiplierFromClientY(volTrack, e.clientY);
        const snapped = snapToTick(raw);
        commitVolume(snapped);
        chrome.storage.local.set({ volumeMultiplier: snapped });
      }
    }, { signal });

    // Window-level drag handlers so the pointer can leave the track without
    // losing the drag. Guarded by volDragging so unrelated pointer activity
    // on the page is ignored.
    window.addEventListener('pointermove', (e) => {
      if (!volDragging) return;
      commitVolume(multiplierFromClientY(volTrack, e.clientY));
    }, { signal });

    const endVolDrag = () => {
      if (!volDragging) return;
      volDragging = false;
      volCursor.classList.remove('sa-dragging');
      chrome.storage.local.set({ volumeMultiplier: state.volumeMultiplier });
    };

    window.addEventListener('pointerup', endVolDrag, { signal });
    window.addEventListener('pointercancel', endVolDrag, { signal });

    // Double-click on the cursor → snap back to 100 %.
    volCursor.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      commitVolume(VOLUME_DEFAULT);
      chrome.storage.local.set({ volumeMultiplier: VOLUME_DEFAULT });
    }, { signal });
  }

  function removeOverlay() {
    if (overlayAbort) { overlayAbort.abort(); overlayAbort = null; }
    if (overlay) { overlay.remove(); overlay = null; dom.bpmEl = null; }
    needsDefaultPosition = false;
  }

  function updateOverlay() {
    if (dom.bpmEl) dom.bpmEl.textContent = state.bpm;
  }

  // =============================================
  //  MAIN LOOP
  // =============================================

  function pollGameState() {
    checkNavigation();

    if (!isGamePage()) {
      if (state.active || overlay) {
        state.active = false;
        state.panicked = false;         // clear the volatile panic flag
        stopAllSounds();
        removeOverlay();
        resetGameCache();
      }
      setPollRate(POLL_SLOW);
      return;
    }

    setPollRate(POLL_FAST);
    if (!overlay) createOverlay();
    else if (needsDefaultPosition) tryApplyDefaultPosition();

    const clocks = readClocks();
    if (!clocks) return;

    state.myTime = clocks.myTime;
    state.opponentTime = clocks.opponentTime;
    state.bpm = calculateBPM(state.myTime, state.opponentTime);
    updateOverlay();
    ensureTotalTime();

    if (isGameRunning()) {
      if (!state.active) {
        state.active = true;
        liveGameObserved = true;
        resultSoundPlayed = false;
        gameOverDetectedAt = 0;
      }

      updateBreathing();

      if (state.soundEnabled && !state.panicked && !heartbeatTimeout) startHeartbeat();
      if (state.soundEnabled && state.breathingEnabled && !state.panicked && !breathing) startBreathing();

      // Critical beeps stay audible even in panic mode: they are the one alert
      // you cannot afford to miss when the clock is about to flag.
      const anyCritical = state.myTime <= CRITICAL_THRESHOLD
                       || state.opponentTime <= CRITICAL_THRESHOLD;
      if (anyCritical && !criticalBeepTimeout && state.soundEnabled) startCriticalBeep();
      else if (!anyCritical) stopCriticalBeep();
    } else {
      if (state.active) {
        state.active = false;
        // Game ended → drop the panic flag so the next game starts unmuted,
        // and refresh the overlay chrome to match.
        if (state.panicked) {
          state.panicked = false;
          if (overlay) overlay.classList.remove('sa-panic');
        }
        stopAllSounds();
      }
      handleGameOver();
    }
  }

  // =============================================
  //  INIT
  // =============================================

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['soundEnabled', 'heartbeatEnabled', 'breathingEnabled',
         'overlayPosition', 'volumeMultiplier', 'collapsed'],
        (data) => {
          if (data.soundEnabled !== undefined) {
            state.soundEnabled = data.soundEnabled;
          } else if (data.heartbeatEnabled !== undefined) {
            // Legacy key migration
            state.soundEnabled = data.heartbeatEnabled;
            chrome.storage.local.set({ soundEnabled: data.heartbeatEnabled });
            chrome.storage.local.remove('heartbeatEnabled');
          }
          if (typeof data.breathingEnabled === 'boolean') {
            state.breathingEnabled = data.breathingEnabled;
          }
          if (typeof data.collapsed === 'boolean') {
            state.collapsed = data.collapsed;
          }
          if (data.overlayPosition) state.overlayPosition = data.overlayPosition;
          if (Number.isFinite(data.volumeMultiplier)) {
            state.volumeMultiplier = clamp(data.volumeMultiplier, VOLUME_MIN, VOLUME_MAX);
          }
          resolve();
        }
      );
    });
  }

  async function init() {
    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    await loadSettings();
    pollInterval = setInterval(pollGameState, currentPollRate);

    chrome.storage.onChanged.addListener((changes) => {
      // Any change to the three M-tracked axes that wasn't part of our own
      // toggleMute write means the user touched something (popup checkbox,
      // slider drag/click, breath button, H, +/-, another tab, …). Consume
      // the pending restore so the next M press does a FRESH mute instead
      // of bringing back stale values — matches the spec "after moving the
      // slide (or changing the button), M mutes again rather than restores".
      const userTouchedMuteAxis = !muteOpInFlight && (
        changes.volumeMultiplier !== undefined ||
        changes.soundEnabled !== undefined ||
        changes.breathingEnabled !== undefined
      );
      if (userTouchedMuteAxis) muteRestoreValid = false;
      muteOpInFlight = false;

      if (changes.soundEnabled) {
        setSoundEnabled(changes.soundEnabled.newValue);
      }
      if (changes.breathingEnabled) {
        setBreathingEnabled(!!changes.breathingEnabled.newValue);
      }
      if (changes.volumeMultiplier) {
        const v = changes.volumeMultiplier.newValue;
        if (Number.isFinite(v)) {
          state.volumeMultiplier = clamp(v, VOLUME_MIN, VOLUME_MAX);
          applyMasterVolume();
          setVolumeCursorPosition(state.volumeMultiplier);
        }
      }
      if (changes.collapsed !== undefined) {
        // Echoed from another tab: apply the class without re-persisting
        // (setCollapsed writes back to storage, which would loop).
        state.collapsed = !!changes.collapsed.newValue;
        if (overlay) overlay.classList.toggle('sa-collapsed', state.collapsed);
      }
    });

    // -----------------------------------------------------------------
    //  Global hotkeys
    //
    //   Space  panic mute toggle (heartbeat + breath silenced, critical
    //          beeps still play, auto-reset at game end)
    //   H      toggle breathing
    //   M      true mute (saves volume, zeros it + disables sound; re-press
    //          restores both)
    //   + / -  nudge volume by ±VOLUME_STEP
    //
    //  Gated on the overlay being present (we are on a Lichess game page
    //  with our UI attached) rather than state.active, because overlay
    //  creation slightly precedes state.active and we need the Space bar
    //  to stop scrolling the page immediately from the first keystroke.
    //
    //  Registered in the capture phase so we get the event before Lichess
    //  or other extensions can react — this is what actually prevents the
    //  default scroll on some Chromium builds.
    //
    //  Suppressed when a text input / chat has the focus so we never steal
    //  a character; Ctrl/Alt/Meta also pass through for native shortcuts.
    // -----------------------------------------------------------------
    document.addEventListener('keydown', (e) => {
      if (!overlay) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // Toggle-style hotkeys use e.code (physical key) and debounce key
      // repeat so holding the key doesn't flicker the state on/off. We
      // still preventDefault on every repeat so Space never falls through
      // to the page's default scroll.
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && state.active) setPanicMode(!state.panicked);
        return;
      }
      if (e.code === 'KeyH') {
        e.preventDefault();
        if (!e.repeat) chrome.storage.local.set({ breathingEnabled: !state.breathingEnabled });
        return;
      }
      if (e.code === 'KeyM') {
        e.preventDefault();
        if (!e.repeat) toggleMute();
        return;
      }

      // Volume nudges use e.key (the glyph typed) so '+' and '-' work on
      // layouts where those characters live in different physical positions
      // than on a US keyboard (Italian, German, French, …). e.key also
      // already covers the numpad '+' / '-', so we don't need a separate
      // case for it. Auto-repeat is welcome: holding the key ramps the
      // volume smoothly.
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        adjustVolume(+VOLUME_STEP);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        adjustVolume(-VOLUME_STEP);
        return;
      }
    }, true);  // capture phase
  }

  init();
})();
