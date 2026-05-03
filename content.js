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

  const saRoot = window.STAYIN_ALIVE || {};
  const saUtils = saRoot.utils || {};
  const saClock = saRoot.clock || {};
  const saMute = saRoot.mute || {};
  const saAudio = saRoot.audio || {};
  const saOverlay = saRoot.overlay || {};
  const saHotkeys = saRoot.hotkeys || {};
  const saStorageSync = saRoot.storageSync || {};
  const saBootstrap = saRoot.bootstrap || {};

  const requiredModules = [
    ['sa.utils', typeof saUtils.clamp === 'function'],
    ['sa.clock',
      typeof saClock.parseClockText === 'function'
      && typeof saClock.calculateBPM === 'function'
      && typeof saClock.parseTimeControlText === 'function'
      && typeof saClock.parseGameResultText === 'function'],
    ['sa.mute', typeof saMute.toggle === 'function' && typeof saMute.applyMute === 'function' && typeof saMute.applyUnmute === 'function' && typeof saMute.isMuteOperationChange === 'function'],
    ['sa.audio', typeof saAudio.createAudioController === 'function'],
    ['sa.overlay', typeof saOverlay.createOverlayController === 'function'],
    ['sa.hotkeys', typeof saHotkeys.registerGlobalHotkeys === 'function'],
    ['sa.storage-sync', typeof saStorageSync.registerStorageSync === 'function'],
    ['sa.bootstrap', typeof saBootstrap.loadSettings === 'function']
  ];
  const missingModules = requiredModules.filter(([, ok]) => !ok).map(([name]) => name);
  if (missingModules.length) {
    console.error(
      '[Stayin\' Alive] Missing required modules:',
      missingModules.join(', '),
      '- check content_scripts order in manifest.json'
    );
    return;
  }

  const cfg = window.STAYIN_ALIVE_CONFIG || {};
  const VERSION = cfg.VERSION || '2.4.2';
  const POLL_FAST = cfg.POLL_FAST ?? 100;            // ms, during a game
  const POLL_SLOW = cfg.POLL_SLOW ?? 1000;           // ms, elsewhere on Lichess
  const BPM_MIN = cfg.BPM_MIN ?? 40;
  const BPM_MAX = cfg.BPM_MAX ?? 180;
  const RESULT_DELAY_MS = cfg.RESULT_DELAY_MS ?? 1000;     // wait before playing the result jingle
  const CRITICAL_THRESHOLD = cfg.CRITICAL_THRESHOLD ?? 5;   // seconds, triggers urgent beeps
  const VOLUME_MIN = cfg.VOLUME_MIN ?? 0;
  const VOLUME_MAX = cfg.VOLUME_MAX ?? 2;             // 200% max, per user request
  const VOLUME_DEFAULT = cfg.VOLUME_DEFAULT ?? 1;     // 100%, the baseline mix
  const VOLUME_STEP = cfg.VOLUME_STEP ?? 0.05;        // ± step for +/- hotkeys, 5 %
  const DRAG_THRESHOLD = cfg.DRAG_THRESHOLD ?? 4;     // px, min pointer movement to count as drag

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
    myClockPos: null                // 'top' | 'bottom'
  };

  // Polling
  let pollInterval = null;
  let currentPollRate = POLL_SLOW;
  let lastUrl = location.href;

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

  const clamp = saUtils.clamp;

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
      audio.stopAllSounds();
    }
    resetGameCache();
    overlayUi.removeOverlay();
  }

  function setPollRate(rate) {
    if (rate === currentPollRate) return;
    if (pollInterval) clearInterval(pollInterval);
    currentPollRate = rate;
    pollInterval = setInterval(pollGameState, rate);
  }

  // =============================================
  //  CLOCK READING & GAME DETECTION
  // =============================================

  const parseClockText = saClock.parseClockText;

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
    return saClock.parseTimeControlText(el.textContent);
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

  const calculateBPM = (myTime, oppTime) =>
    saClock.calculateBPM(myTime, oppTime, BPM_MIN, BPM_MAX);

  const audio = saAudio.createAudioController({
    getSoundEnabled: () => state.soundEnabled,
    getBreathingEnabled: () => state.breathingEnabled,
    getActive: () => state.active,
    getPanicked: () => state.panicked,
    getVolumeMultiplier: () => state.volumeMultiplier,
    getBpm: () => state.bpm,
    getMyTime: () => state.myTime,
    getOpponentTime: () => state.opponentTime,
    getTimeUrgency: () => getTimeUrgency(),
    getAdvantageRatio: () => getAdvantageRatio(),
    criticalThreshold: CRITICAL_THRESHOLD
  });

  // =============================================
  //  RESULT DETECTION
  // =============================================

  function detectGameResult() {
    const el = document.querySelector('.result-wrap .result');
    if (!el) return null;
    const drawResult = saClock.parseGameResultText(el.textContent, null);
    if (drawResult === 'draw') return drawResult;

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

    return saClock.parseGameResultText(el.textContent, userIsWhite);
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
      audio.playResultSound(result);
      resultSoundPlayed = true;
    }
  }

  // =============================================
  //  SOUND CONTROL
  // =============================================

  /**
   * Single source of truth for toggling sound. Updates state and restarts or
   * stops the audio pipelines. The popup owns the UI for this toggle.
   */
  function setSoundEnabled(enabled) {
    if (state.soundEnabled === enabled) return;
    state.soundEnabled = enabled;
    if (enabled && state.active) {
      audio.startHeartbeat();
      audio.startBreathing();
    } else {
      audio.stopAllSounds();
    }
    overlayUi.setSoundChrome(enabled);
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
      audio.startBreathing();
    } else {
      audio.stopBreathing();
    }
    overlayUi.setBreathingChrome(enabled);
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
      audio.stopHeartbeat();
      audio.stopBreathing();
    } else if (state.soundEnabled && state.active) {
      audio.startHeartbeat();
      if (state.breathingEnabled) audio.startBreathing();
    }
    overlayUi.setPanicChrome(enabled);
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
    overlayUi.setCollapsedChrome(v);
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
    audio.applyMasterVolume();
    overlayUi.setVolumeCursorPosition(next);
    chrome.storage.local.set({ volumeMultiplier: next });

    overlayUi.flashVolumeReadout();
  }

  /**
   * Thin wrapper around the shared sa.mute API. The state machine, snapshot
   * policy and restore validity rules all live in sa.mute.js so that the M
   * hotkey here and the popup checkbox in popup.js share identical
   * semantics. See sa.mute.js for the full contract.
   */
  function toggleMute() {
    return saMute.toggle();
  }

  const overlayUi = saOverlay.createOverlayController({
    clamp,
    version: VERSION,
    dragThreshold: DRAG_THRESHOLD,
    volumeMin: VOLUME_MIN,
    volumeMax: VOLUME_MAX,
    volumeDefault: VOLUME_DEFAULT,
    getBpm: () => state.bpm,
    getSoundEnabled: () => state.soundEnabled,
    getBreathingEnabled: () => state.breathingEnabled,
    getCollapsed: () => state.collapsed,
    getPanicked: () => state.panicked,
    getVolumeMultiplier: () => state.volumeMultiplier,
    getOverlayPosition: () => state.overlayPosition,
    setOverlayPosition: (value) => { state.overlayPosition = value; },
    persistOverlayPosition: (value) => chrome.storage.local.set({ overlayPosition: value }),
    setCollapsed: (value) => setCollapsed(value),
    toggleBreathing: () => chrome.storage.local.set({ breathingEnabled: !state.breathingEnabled }),
    setVolumeMultiplier: (value) => {
      state.volumeMultiplier = value;
      audio.applyMasterVolume();
    },
    persistVolumeMultiplier: (value) => chrome.storage.local.set({ volumeMultiplier: value })
  });
  // =============================================
  //  MAIN LOOP
  // =============================================

  function pollGameState() {
    checkNavigation();

    if (!isGamePage()) {
      if (state.active || overlayUi.isVisible()) {
        state.active = false;
        state.panicked = false;         // clear the volatile panic flag
        audio.stopAllSounds();
        overlayUi.removeOverlay();
        resetGameCache();
      }
      setPollRate(POLL_SLOW);
      return;
    }

    setPollRate(POLL_FAST);
    if (!overlayUi.isVisible()) overlayUi.createOverlay();
    else overlayUi.tryApplyDefaultPosition();

    const clocks = readClocks();
    if (!clocks) return;

    state.myTime = clocks.myTime;
    state.opponentTime = clocks.opponentTime;
    state.bpm = calculateBPM(state.myTime, state.opponentTime);
    overlayUi.updateBpm();
    ensureTotalTime();

    if (isGameRunning()) {
      if (!state.active) {
        state.active = true;
        liveGameObserved = true;
        resultSoundPlayed = false;
        gameOverDetectedAt = 0;
      }

      audio.updateBreathing();

      if (state.soundEnabled && !state.panicked && !audio.isHeartbeatRunning()) audio.startHeartbeat();
      if (state.soundEnabled && state.breathingEnabled && !state.panicked && !audio.isBreathingRunning()) audio.startBreathing();

      // Critical beeps stay audible even in panic mode: they are the one alert
      // you cannot afford to miss when the clock is about to flag.
      const anyCritical = state.myTime <= CRITICAL_THRESHOLD
                       || state.opponentTime <= CRITICAL_THRESHOLD;
      if (anyCritical && !audio.isCriticalBeepRunning() && state.soundEnabled) audio.startCriticalBeep();
      else if (!anyCritical) audio.stopCriticalBeep();
    } else {
      if (state.active) {
        state.active = false;
        // Game ended → drop the panic flag so the next game starts unmuted,
        // and refresh the overlay chrome to match.
        if (state.panicked) {
          state.panicked = false;
          overlayUi.setPanicChrome(false);
        }
        audio.stopAllSounds();
      }
      handleGameOver();
    }
  }

  // =============================================
  //  INIT
  // =============================================

  async function init() {
    audio.registerUnlockListeners(document);

    await saBootstrap.loadSettings({
      setSoundEnabled: (value) => { state.soundEnabled = value; },
      setBreathingEnabled: (value) => { state.breathingEnabled = value; },
      setCollapsed: (value) => { state.collapsed = value; },
      setOverlayPosition: (value) => { state.overlayPosition = value; },
      setVolumeMultiplier: (value) => { state.volumeMultiplier = value; },
      clampVolume: (value) => clamp(value, VOLUME_MIN, VOLUME_MAX)
    });
    pollInterval = setInterval(pollGameState, currentPollRate);

    saStorageSync.registerStorageSync({
      setSoundEnabled: (value) => setSoundEnabled(value),
      setBreathingEnabled: (value) => setBreathingEnabled(value),
      onVolumeMultiplierChange: (value) => {
        state.volumeMultiplier = clamp(value, VOLUME_MIN, VOLUME_MAX);
        audio.applyMasterVolume();
        overlayUi.setVolumeCursorPosition(state.volumeMultiplier);
      },
      onCollapsedChange: (value) => {
        state.collapsed = value;
        overlayUi.setCollapsedChrome(state.collapsed);
      }
    });

    saHotkeys.registerGlobalHotkeys({
      isOverlayVisible: () => overlayUi.isVisible(),
      isGameActive: () => state.active,
      isPanicked: () => state.panicked,
      togglePanic: (enabled) => setPanicMode(enabled),
      toggleBreathing: () =>
        chrome.storage.local.set({ breathingEnabled: !state.breathingEnabled }),
      toggleMute: () => toggleMute(),
      adjustVolume: (dir) => adjustVolume(dir * VOLUME_STEP)
    });
  }

  init();
})();
