/*
 * Overlay UI controller for Stayin' Alive.
 *
 * Owns the overlay DOM, positioning, drag gestures, mini mode chrome and
 * volume slider wiring. Application state stays in content.js and is exposed
 * here through getters/callbacks.
 */
(function () {
  'use strict';

  const root = window.STAYIN_ALIVE || (window.STAYIN_ALIVE = {});

  function createOverlayController(options) {
    const {
      clamp,
      version,
      dragThreshold,
      volumeMin,
      volumeMax,
      volumeDefault,
      getBpm,
      getSoundEnabled,
      getBreathingEnabled,
      getCollapsed,
      getPanicked,
      getVolumeMultiplier,
      getOverlayPosition,
      setOverlayPosition,
      persistOverlayPosition,
      setCollapsed,
      toggleBreathing,
      setVolumeMultiplier,
      persistVolumeMultiplier
    } = options;

    const BOARD_SELECTORS = '.round__app__board, .main-board, cg-wrap, .cg-wrap';
    const THEME_SOURCE_SELECTORS = '.round__side, .game__meta, main';
    const OVERLAY_GAP = 8;

    let overlay = null;
    let overlayAbort = null;
    let bpmEl = null;
    let needsDefaultPosition = false;
    let nudgeTimeout = null;

    function applyLichessTheme() {
      if (!overlay) return;
      const source = document.querySelector(THEME_SOURCE_SELECTORS) || document.body;

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
      setOverlayPosition(c);
    }

    function tryApplyDefaultPosition() {
      if (!needsDefaultPosition || !overlay) return;
      const pos = computeDefaultPosition();
      if (pos) {
        applyPosition(pos);
        needsDefaultPosition = false;
      } else if (overlay.style.visibility === 'hidden') {
        applyPosition({ x: 20, y: 80 });
      }
    }

    function multiplierFromClientY(trackEl, clientY) {
      const rect = trackEl.getBoundingClientRect();
      if (!rect.height) return getVolumeMultiplier();
      const y = clamp(clientY - rect.top, 0, rect.height);
      const frac = y / rect.height;
      return clamp((1 - frac) * volumeMax, volumeMin, volumeMax);
    }

    function setVolumeCursorPosition(multiplier) {
      if (!overlay) return;
      const cursor = overlay.querySelector('.sa-volume-cursor');
      const readout = overlay.querySelector('.sa-volume-readout');
      if (!cursor) return;
      const frac = 1 - multiplier / volumeMax;
      cursor.style.top = (frac * 100) + '%';
      if (readout) readout.textContent = Math.round(multiplier * 100) + '%';
    }

    function snapToTick(multiplier) {
      const ticks = [volumeMin, volumeDefault, volumeMax];
      let best = ticks[0], bestD = Infinity;
      for (const t of ticks) {
        const d = Math.abs(multiplier - t);
        if (d < bestD) { best = t; bestD = d; }
      }
      return best;
    }

    function setVolumeWithChrome(multiplier) {
      setVolumeMultiplier(multiplier);
      setVolumeCursorPosition(multiplier);
    }

    function flashVolumeReadout() {
      if (!overlay) return;
      const cursor = overlay.querySelector('.sa-volume-cursor');
      if (!cursor) return;
      cursor.classList.add('sa-nudged');
      if (nudgeTimeout) clearTimeout(nudgeTimeout);
      nudgeTimeout = setTimeout(() => {
        cursor.classList.remove('sa-nudged');
        nudgeTimeout = null;
      }, 700);
    }

    function setBreathingChrome(enabled) {
      if (!overlay) return;
      const btn = overlay.querySelector('.sa-toggle');
      if (!btn) return;
      btn.classList.toggle('sa-off', !enabled);
      btn.title = enabled ? 'Breath on' : 'Breath off';
    }

    function setSoundChrome(enabled) {
      if (!overlay) return;
      overlay.classList.toggle('sa-muted', !enabled);
      const title = overlay.querySelector('.sa-title');
      const collapsedHeart = overlay.querySelector('.sa-collapsed-heart');
      const volume = overlay.querySelector('.sa-volume');
      const hint = enabled ? 'Audio feedback on' : 'Audio feedback off (press M or enable it from the popup)';
      if (title) title.title = hint;
      if (collapsedHeart) collapsedHeart.title = getCollapsed() ? `Expand - ${hint}` : 'Expand';
      if (volume) volume.title = enabled ? 'Volume' : 'Volume (audio feedback off)';
    }

    function createOverlay() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.id = 'stayin-alive-overlay';
      overlay.style.visibility = 'hidden';
      overlay.innerHTML = `
        <div class="sa-collapsed-heart sa-drag-handle" title="Expand">\u2665</div>
        <div class="sa-header sa-drag-handle">
          <div class="sa-title-zone">
            <span class="sa-title"><span class="sa-heart" title="Collapse">\u2665</span> Stayin' Alive</span>
          </div>
          <div class="sa-toggle-zone">
            <button class="sa-toggle${getBreathingEnabled() ? '' : ' sa-off'}" aria-label="Toggle breathing sound" title="${getBreathingEnabled() ? 'Breath on' : 'Breath off'}"></button>
          </div>
        </div>
        <div class="sa-body">
          <div class="sa-content">
            <div class="sa-bpm">
              <span class="sa-bpm-value">${getBpm()}</span>
              <span class="sa-bpm-label">BPM</span>
            </div>
            <div class="sa-version">v${version} by LBSoft</div>
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
      if (getCollapsed()) overlay.classList.add('sa-collapsed');
      if (getPanicked()) overlay.classList.add('sa-panic');
      if (!getSoundEnabled()) overlay.classList.add('sa-muted');
      document.body.appendChild(overlay);
      bpmEl = overlay.querySelector('.sa-bpm-value');
      applyLichessTheme();
      setVolumeCursorPosition(getVolumeMultiplier());
      setSoundChrome(getSoundEnabled());

      needsDefaultPosition = false;

      chrome.storage.local.get('overlayPosition', (data) => {
        if (!overlay) return;
        if (data.overlayPosition) {
          applyPosition(data.overlayPosition);
        } else {
          needsDefaultPosition = true;
          tryApplyDefaultPosition();
        }
      });

      overlayAbort = new AbortController();
      const { signal } = overlayAbort;

      const toggleBtn = overlay.querySelector('.sa-toggle');

      function wireDragHandle(handleEl) {
        let dragging = false, dragX = 0, dragY = 0, downX = 0, downY = 0, moved = false;

        handleEl.addEventListener('pointerdown', (e) => {
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
              (Math.abs(e.clientX - downX) > dragThreshold ||
               Math.abs(e.clientY - downY) > dragThreshold)) {
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
            const pos = { x: overlay.offsetLeft, y: overlay.offsetTop };
            setOverlayPosition(pos);
            needsDefaultPosition = false;
            persistOverlayPosition(pos);
          } else if (handleEl.classList.contains('sa-collapsed-heart')) {
            setCollapsed(false);
          }
        };

        handleEl.addEventListener('pointerup', endDrag, { signal });
        handleEl.addEventListener('pointercancel', endDrag, { signal });
      }

      overlay.querySelectorAll('.sa-drag-handle').forEach(wireDragHandle);

      const titleHeart = overlay.querySelector('.sa-header .sa-heart');
      if (titleHeart) {
        titleHeart.addEventListener('click', (e) => {
          e.stopPropagation();
          setCollapsed(true);
        }, { signal });
      }

      window.addEventListener('resize', () => {
        const pos = getOverlayPosition();
        if (overlay && pos) applyPosition(pos);
      }, { signal });

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBreathing();
        toggleBtn.blur();
      }, { signal });

      const volTrack = overlay.querySelector('.sa-volume-track');
      const volCursor = overlay.querySelector('.sa-volume-cursor');
      let volDragging = false;

      volTrack.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.target.closest('.sa-volume-cursor')) {
          volDragging = true;
          volCursor.classList.add('sa-dragging');
        } else {
          const raw = multiplierFromClientY(volTrack, e.clientY);
          const snapped = snapToTick(raw);
          setVolumeWithChrome(snapped);
          persistVolumeMultiplier(snapped);
        }
      }, { signal });

      window.addEventListener('pointermove', (e) => {
        if (!volDragging) return;
        setVolumeWithChrome(multiplierFromClientY(volTrack, e.clientY));
      }, { signal });

      const endVolDrag = () => {
        if (!volDragging) return;
        volDragging = false;
        volCursor.classList.remove('sa-dragging');
        persistVolumeMultiplier(getVolumeMultiplier());
      };

      window.addEventListener('pointerup', endVolDrag, { signal });
      window.addEventListener('pointercancel', endVolDrag, { signal });

      volCursor.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        setVolumeWithChrome(volumeDefault);
        persistVolumeMultiplier(volumeDefault);
      }, { signal });
    }

    function removeOverlay() {
      if (overlayAbort) { overlayAbort.abort(); overlayAbort = null; }
      if (overlay) { overlay.remove(); overlay = null; bpmEl = null; }
      needsDefaultPosition = false;
    }

    function updateBpm() {
      if (bpmEl) bpmEl.textContent = getBpm();
    }

    function setCollapsedChrome(value) {
      if (overlay) overlay.classList.toggle('sa-collapsed', !!value);
    }

    function setPanicChrome(value) {
      if (overlay) overlay.classList.toggle('sa-panic', !!value);
    }

    return Object.freeze({
      createOverlay,
      removeOverlay,
      updateBpm,
      tryApplyDefaultPosition,
      setVolumeCursorPosition,
      flashVolumeReadout,
      setSoundChrome,
      setBreathingChrome,
      setCollapsedChrome,
      setPanicChrome,
      isVisible: () => !!overlay
    });
  }

  root.overlay = Object.freeze({
    createOverlayController
  });
})();
