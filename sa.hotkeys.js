/*
 * Global hotkeys wiring for Stayin' Alive.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});

  /**
   * Registers capture-phase keydown hotkeys and returns an unsubscribe fn.
   */
  function registerGlobalHotkeys(options) {
    const {
      isOverlayVisible,
      isGameActive,
      isPanicked,
      togglePanic,
      toggleBreathing,
      toggleMute,
      adjustVolume
    } = options;

    const onKeyDown = (e) => {
      if (!isOverlayVisible()) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && isGameActive()) togglePanic(!isPanicked());
        return;
      }
      if (e.code === 'KeyH') {
        e.preventDefault();
        if (!e.repeat) toggleBreathing();
        return;
      }
      if (e.code === 'KeyM') {
        e.preventDefault();
        if (!e.repeat) toggleMute();
        return;
      }

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        adjustVolume(+1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        adjustVolume(-1);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }

  root.hotkeys = Object.freeze({
    registerGlobalHotkeys
  });
})();
