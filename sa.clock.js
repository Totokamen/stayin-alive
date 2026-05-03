/*
 * Clock parsing and tempo calculations for Stayin' Alive.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});
  const clamp = root.utils?.clamp || ((v, min, max) => Math.max(min, Math.min(max, v)));

  root.clock = Object.freeze({
    parseClockText(text) {
      const s = text.trim();
      const parts = s.split(':');
      if (parts.length === 2) {
        const m = parseInt(parts[0], 10);
        const sec = parseFloat(parts[1]);
        if (isNaN(m) || isNaN(sec)) return NaN;
        return m * 60 + sec;
      }
      return parseFloat(s);
    },

    calculateBPM(myTime, oppTime, bpmMin, bpmMax) {
      const ratio = Math.max(myTime, 0.1) / Math.max(oppTime, 0.1);
      const pressure = (1.6 - clamp(Math.log2(ratio), -1.6, 1.6)) / 3.2;
      return Math.round(bpmMin + pressure * (bpmMax - bpmMin));
    },

    parseTimeControlText(text) {
      const match = String(text || '').match(/(\d+)\+(\d+)/);
      return match ? parseInt(match[1], 10) * 60 : 0;
    },

    parseGameResultText(resultText, userIsWhite) {
      const result = String(resultText || '').trim();
      if (result === '½-½') return 'draw';
      if (typeof userIsWhite !== 'boolean') return null;
      if (result === '1-0') return userIsWhite ? 'win' : 'loss';
      if (result === '0-1') return userIsWhite ? 'loss' : 'win';
      return null;
    }
  });
})();
