/*
 * Web Audio engine for Stayin' Alive.
 *
 * Owns audio nodes, timers and sound scheduling. The content script keeps
 * application state; this module reads it through getters passed to
 * createAudioController().
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});

  function createAudioController(options) {
    const {
      getSoundEnabled,
      getBreathingEnabled,
      getActive,
      getPanicked,
      getVolumeMultiplier,
      getBpm,
      getMyTime,
      getOpponentTime,
      getTimeUrgency,
      getAdvantageRatio,
      criticalThreshold
    } = options;

    let audioCtx = null;
    let audioUnlocked = false;
    let noiseBuffer = null;
    let masterGain = null;

    let heartbeatTimeout = null;
    let criticalBeepTimeout = null;
    let breathing = null;

    function unlockAudio() {
      if (audioUnlocked) return;
      try {
        ensureAudioContext();
        audioUnlocked = true;
      } catch (e) { /* ignore */ }
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
    }

    function registerUnlockListeners(doc) {
      doc.addEventListener('click', unlockAudio);
      doc.addEventListener('keydown', unlockAudio);
    }

    function ensureAudioContext() {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = getVolumeMultiplier();
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    }

    const isAudioReady = () =>
      audioUnlocked && audioCtx && audioCtx.state === 'running';

    function applyMasterVolume() {
      if (!masterGain || !audioCtx) return;
      const now = audioCtx.currentTime;
      try {
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(masterGain.gain.value, now);
        masterGain.gain.linearRampToValueAtTime(getVolumeMultiplier(), now + 0.05);
      } catch (e) { /* ignore */ }
    }

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

    function playHeartbeatPulse() {
      if (!isAudioReady()) return;
      const now = audioCtx.currentTime;
      const urgency = getTimeUrgency();
      const vol = 0.15 + urgency * urgency * 0.65;
      playTone(55, now,        0.15, vol);
      playTone(75, now + 0.12, 0.10, vol * 0.6);
    }

    function scheduleHeartbeat() {
      if (!getSoundEnabled() || !getActive() || getPanicked()) return;
      playHeartbeatPulse();
      heartbeatTimeout = setTimeout(scheduleHeartbeat, 60000 / getBpm());
    }

    function startHeartbeat() {
      stopHeartbeat();
      if (getSoundEnabled() && getActive() && !getPanicked()) scheduleHeartbeat();
    }

    function stopHeartbeat() {
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
    }

    function startBreathing() {
      if (breathing || !getSoundEnabled() || !getBreathingEnabled()
          || !getActive() || getPanicked() || !isAudioReady()) return;
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
      let vol = urgency * urgency * urgency * 0.12;

      if (ratio >= 4)      vol *= 0.05;
      else if (ratio >= 3) vol *= 0.50;
      else if (ratio > 2)  vol *= 0.75;

      const filterFreq = 300 + urgency * 400;
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

    function playCriticalBeep(freq) {
      if (!isAudioReady()) return;
      playTone(freq, audioCtx.currentTime, 0.07, 0.10, {
        type: 'square', attack: 0.01, decay: 'lin'
      });
    }

    function scheduleCriticalBeep() {
      if (!getActive() || !getSoundEnabled()) { stopCriticalBeep(); return; }
      const my = typeof getMyTime() === 'number' ? getMyTime() : Infinity;
      const opp = typeof getOpponentTime() === 'number' ? getOpponentTime() : Infinity;
      const myCrit = my <= criticalThreshold;
      const oppCrit = opp <= criticalThreshold;

      if (!myCrit && !oppCrit) { stopCriticalBeep(); return; }

      if (myCrit) {
        playCriticalBeep(880);
        criticalBeepTimeout = setTimeout(scheduleCriticalBeep,
          120 + (my / criticalThreshold) * 80);
      } else {
        playCriticalBeep(330);
        criticalBeepTimeout = setTimeout(scheduleCriticalBeep,
          200 + (opp / criticalThreshold) * 150);
      }
    }

    function startCriticalBeep() {
      if (!criticalBeepTimeout) scheduleCriticalBeep();
    }

    function stopCriticalBeep() {
      if (criticalBeepTimeout) {
        clearTimeout(criticalBeepTimeout);
        criticalBeepTimeout = null;
      }
    }

    function playVictorySound() {
      if (!isAudioReady()) return;
      const now = audioCtx.currentTime;
      const u = 0.22;
      playTone(523, now,         u,     0.25);
      playTone(659, now + u,     u,     0.25);
      playTone(784, now + u * 2, u * 4, 0.28);
    }

    function playDefeatSound() {
      if (!isAudioReady()) return;
      const now = audioCtx.currentTime;
      const u = 0.2;
      playTone(392, now,         u,     0.20);
      playTone(392, now + u,     u,     0.20);
      playTone(392, now + u * 2, u,     0.20);
      playTone(311, now + u * 3, u * 3, 0.17);
    }

    function playDrawSound() {
      if (!isAudioReady()) return;
      const now = audioCtx.currentTime;
      const u = 0.28;
      playTone(196, now,         u,     0.19);
      playTone(196, now + u,     u,     0.19);
      playTone(196, now + u * 2, u * 2, 0.19);
    }

    function playResultSound(result) {
      if (result === 'win')  playVictorySound();
      if (result === 'loss') playDefeatSound();
      if (result === 'draw') playDrawSound();
    }

    function stopAllSounds() {
      stopHeartbeat();
      stopBreathing();
      stopCriticalBeep();
    }

    return Object.freeze({
      registerUnlockListeners,
      applyMasterVolume,
      startHeartbeat,
      stopHeartbeat,
      isHeartbeatRunning: () => !!heartbeatTimeout,
      startBreathing,
      updateBreathing,
      stopBreathing,
      isBreathingRunning: () => !!breathing,
      startCriticalBeep,
      stopCriticalBeep,
      isCriticalBeepRunning: () => !!criticalBeepTimeout,
      playResultSound,
      stopAllSounds
    });
  }

  root.audio = Object.freeze({
    createAudioController
  });
})();
