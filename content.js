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

  const VERSION = '2.3.1';
  const POLL_FAST = 100;            // ms, during a game
  const POLL_SLOW = 1000;           // ms, elsewhere on Lichess
  const BPM_MIN = 40;
  const BPM_MAX = 180;
  const RESULT_DELAY_MS = 1000;     // wait before playing the result jingle
  const CRITICAL_THRESHOLD = 5;     // seconds, triggers urgent beeps

  // =============================================
  //  STATE
  // =============================================

  const state = {
    active: false,
    soundEnabled: true,
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

  // End-of-game handling
  let resultSoundPlayed = false;
  let gameOverDetectedAt = 0;

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
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  const isAudioReady = () =>
    audioUnlocked && audioCtx && audioCtx.state === 'running';

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
      osc.connect(g).connect(audioCtx.destination);
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
    if (!state.soundEnabled || !state.active) return;
    playHeartbeatPulse();
    heartbeatTimeout = setTimeout(scheduleHeartbeat, 60000 / state.bpm);
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (state.soundEnabled && state.active) scheduleHeartbeat();
  }

  function stopHeartbeat() {
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  }

  // =============================================
  //  BREATHING (organic rhythmic whoosh)
  // =============================================

  function startBreathing() {
    if (breathing || !state.soundEnabled || !state.active || !isAudioReady()) return;
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
      gain.connect(audioCtx.destination);
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
   * Single source of truth for toggling sound. Updates state, restarts or
   * stops audio pipelines, and syncs the overlay button UI.
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
    if (overlay) {
      const btn = overlay.querySelector('.sa-toggle');
      if (btn) {
        btn.textContent = enabled ? 'ON' : 'OFF';
        btn.classList.toggle('sa-off', !enabled);
      }
    }
  }

  // =============================================
  //  OVERLAY
  // =============================================

  function constrainToViewport(x, y) {
    const w = overlay ? overlay.offsetWidth : 130;
    const h = overlay ? overlay.offsetHeight : 80;
    return {
      x: clamp(x, 0, Math.max(0, window.innerWidth - w)),
      y: clamp(y, 0, Math.max(0, window.innerHeight - h))
    };
  }

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'stayin-alive-overlay';
    overlay.innerHTML = `
      <div class="sa-header">
        <span class="sa-title">\u2665 Stayin' Alive</span>
        <button class="sa-toggle${state.soundEnabled ? '' : ' sa-off'}" title="Toggle sounds">${state.soundEnabled ? 'ON' : 'OFF'}</button>
      </div>
      <div class="sa-bpm">
        <span class="sa-bpm-value">${state.bpm}</span>
        <span class="sa-bpm-label">BPM</span>
      </div>
      <div class="sa-version">v${VERSION} by LBSoft</div>
    `;
    document.body.appendChild(overlay);
    dom.bpmEl = overlay.querySelector('.sa-bpm-value');

    // Restore saved position (async) and clamp to current viewport
    chrome.storage.local.get('overlayPosition', (data) => {
      if (data.overlayPosition) state.overlayPosition = data.overlayPosition;
      if (!overlay) return; // overlay destroyed before callback fired
      const pos = constrainToViewport(state.overlayPosition.x, state.overlayPosition.y);
      overlay.style.left = pos.x + 'px';
      overlay.style.top = pos.y + 'px';
    });

    // All listeners share one AbortController so they're cleaned up together
    // when the overlay is removed (prevents leaks on SPA navigation).
    overlayAbort = new AbortController();
    const { signal } = overlayAbort;

    let dragging = false, dragX = 0, dragY = 0;

    overlay.querySelector('.sa-header').addEventListener('mousedown', (e) => {
      dragging = true;
      dragX = e.clientX - overlay.offsetLeft;
      dragY = e.clientY - overlay.offsetTop;
      e.preventDefault();
    }, { signal });

    document.addEventListener('mousemove', (e) => {
      if (!dragging || !overlay) return;
      const pos = constrainToViewport(e.clientX - dragX, e.clientY - dragY);
      overlay.style.left = pos.x + 'px';
      overlay.style.top = pos.y + 'px';
    }, { signal });

    document.addEventListener('mouseup', () => {
      if (!dragging || !overlay) return;
      dragging = false;
      state.overlayPosition = { x: overlay.offsetLeft, y: overlay.offsetTop };
      chrome.storage.local.set({ overlayPosition: state.overlayPosition });
    }, { signal });

    overlay.querySelector('.sa-toggle').addEventListener('click', () => {
      // Single source of truth: write to storage, the onChanged listener
      // applies it everywhere (including this overlay's UI).
      chrome.storage.local.set({ soundEnabled: !state.soundEnabled });
    }, { signal });
  }

  function removeOverlay() {
    if (overlayAbort) { overlayAbort.abort(); overlayAbort = null; }
    if (overlay) { overlay.remove(); overlay = null; dom.bpmEl = null; }
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
        stopAllSounds();
        removeOverlay();
        resetGameCache();
      }
      setPollRate(POLL_SLOW);
      return;
    }

    setPollRate(POLL_FAST);
    if (!overlay) createOverlay();

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
        resultSoundPlayed = false;
        gameOverDetectedAt = 0;
      }

      updateBreathing();

      if (state.soundEnabled && !heartbeatTimeout) startHeartbeat();
      if (state.soundEnabled && !breathing)       startBreathing();

      const anyCritical = state.myTime <= CRITICAL_THRESHOLD
                       || state.opponentTime <= CRITICAL_THRESHOLD;
      if (anyCritical && !criticalBeepTimeout && state.soundEnabled) startCriticalBeep();
      else if (!anyCritical) stopCriticalBeep();
    } else {
      if (state.active) {
        state.active = false;
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
        ['soundEnabled', 'heartbeatEnabled', 'overlayPosition'],
        (data) => {
          if (data.soundEnabled !== undefined) {
            state.soundEnabled = data.soundEnabled;
          } else if (data.heartbeatEnabled !== undefined) {
            // Legacy key migration
            state.soundEnabled = data.heartbeatEnabled;
            chrome.storage.local.set({ soundEnabled: data.heartbeatEnabled });
            chrome.storage.local.remove('heartbeatEnabled');
          }
          if (data.overlayPosition) state.overlayPosition = data.overlayPosition;
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
      if (changes.soundEnabled) {
        setSoundEnabled(changes.soundEnabled.newValue);
      }
    });
  }

  init();
})();
