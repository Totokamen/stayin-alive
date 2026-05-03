# Stayin' Alive Architecture

This file is a compact map for future changes. Read it before editing the
extension: most regressions so far came from forgetting which module owns a
piece of state.

## Current Release

- Current version: `2.4.2`.
- Target site: `lichess.org` only.
- Extension type: MV3, no build step, plain JavaScript files loaded in order.
- Source control: local SVN/TortoiseSVN working copy.

## Load Order

`manifest.json` loads content scripts in this exact order:

1. `content.config.js`
2. `sa.utils.js`
3. `sa.clock.js`
4. `sa.mute.js`
5. `sa.audio.js`
6. `sa.overlay.js`
7. `sa.hotkeys.js`
8. `sa.storage-sync.js`
9. `sa.bootstrap.js`
10. `content.js`

`content.js` has a module-presence guard at startup. If a module is missing or
loaded out of order, the content script logs a clear error and exits.

The popup loads:

1. `content.config.js`
2. `sa.mute.js`
3. `popup.js`

This is intentional: the popup must use the same mute/unmute state machine as
the `M` hotkey.

## Global Namespace

Modules export onto `window.STAYIN_ALIVE`:

- `window.STAYIN_ALIVE.utils`
- `window.STAYIN_ALIVE.clock`
- `window.STAYIN_ALIVE.mute`
- `window.STAYIN_ALIVE.audio`
- `window.STAYIN_ALIVE.overlay`
- `window.STAYIN_ALIVE.hotkeys`
- `window.STAYIN_ALIVE.storageSync`
- `window.STAYIN_ALIVE.bootstrap`

Config currently lives separately as `window.STAYIN_ALIVE_CONFIG`.

## Module Responsibilities

### `content.config.js`

Owns release/version constants and tuning constants:

- `VERSION`
- polling rates
- BPM min/max
- result delay
- critical threshold
- volume min/max/default/step
- drag threshold

When bumping a release, update `manifest.json`, `content.config.js`,
`popup.html`, and the fallback `VERSION` in `content.js`.

### `sa.utils.js`

Currently exports only:

- `clamp(value, min, max)`

This is intentionally small but borderline anemic. If future helpers appear,
put truly generic helpers here. Do not put domain state here.

### `sa.clock.js`

Clock-domain pure helpers:

- `parseClockText(text)`
- `calculateBPM(myTime, oppTime, bpmMin, bpmMax)`
- `parseTimeControlText(text)`
- `parseGameResultText(resultText, userIsWhite)`

It does not read DOM or storage. `2.4.2` moved time-control and result-text
parsing here while leaving DOM detection and polling in `content.js`.

### `sa.mute.js`

Owns the true-mute state machine shared by:

- `M` hotkey from `content.js`
- `Audio feedback` checkbox from `popup.js`
- storage-sync classification via `isMuteOperationChange(changes)`

Public API:

- `applyMute()`
- `applyUnmute()`
- `toggle()`
- `isMuteOperationChange(changes)`

Important rule: do not reintroduce in-memory mute flags such as
`muteRestoreValid` or `muteOpInFlight`. Popup, content scripts on different
tabs, and future settings pages live in separate JavaScript realms. Storage is
the source of truth.

Storage contract owned by `sa.mute.js`:

- `volumeBeforeMute`: exists iff a volume restore is available.
- `breathingBeforeMute`: sticky across re-mutes; removed only on full unmute.

Other modules must not write the `*BeforeMute` keys directly. The storage-sync
listener relies on seeing those keys in `chrome.storage.onChanged` to identify
our own mute operation.

Mute semantics:

- `applyMute()` saves a volume snapshot, saves sticky breath if needed, then
  writes `soundEnabled:false`, `volumeMultiplier:0`, `breathingEnabled:false`.
- `applyUnmute()` restores volume from snapshot, else current positive volume,
  else default; restores breath from sticky snapshot if present; then removes
  both snapshot keys.
- `toggle()` is for `M`: if muted and `volumeBeforeMute` exists, restore;
  otherwise perform a fresh mute.

### `sa.audio.js`

Owns Web Audio resources and sound scheduling:

- `AudioContext`
- `masterGain`
- heartbeat pulse scheduling
- breathing noise layer
- critical beep scheduling
- win/loss/draw result jingles

It does not own app state. It reads state through getters passed from
`content.js` via `createAudioController(options)`.

Audio is gated by:

- `soundEnabled`
- `active`
- `panicked`
- `breathingEnabled` for the breathing layer only
- `AudioContext` unlock state

Panic mode silences heartbeat and breathing, but critical beeps remain audible.

Important browser note: Web Audio may not start until a user gesture. The
current implementation registers click/keydown unlock listeners from
`content.js`.

### `sa.overlay.js`

Owns overlay DOM and overlay-only UI behavior:

- creates/removes overlay
- applies Lichess theme colors
- positions overlay near the board
- handles drag positioning
- handles collapsed mini mode
- handles volume slider interactions
- exposes chrome updates for sound, breathing, collapse, panic, BPM

It does not own persisted state. It receives getters/callbacks from
`content.js`.

Persisted effects called through callbacks:

- `overlayPosition`
- `collapsed`
- `volumeMultiplier`
- `breathingEnabled`

`2.4.1` added `sa-muted` chrome so the overlay clearly shows when
`soundEnabled=false`.

### `sa.hotkeys.js`

Registers capture-phase global hotkeys:

- `Space`: panic mode, only while a live game is active.
- `H`: toggle breathing layer.
- `M`: shared true mute via `sa.mute.toggle()`.
- `+` / `=`: increase volume by one step.
- `-` / `_`: decrease volume by one step.

The hotkey listener ignores editable fields and ctrl/alt/meta combos.

Panic mode is volatile and live-game-only. It is reset when a game ends or when
leaving the game page.

### `sa.storage-sync.js`

Owns `chrome.storage.onChanged` synchronization into `content.js` state.

It applies changes for:

- `soundEnabled`
- `breathingEnabled`
- `volumeMultiplier`
- `collapsed`

It also invalidates mute snapshots on direct single-axis user touches:

- slider / `+` / `-`
- breath toggle / `H`
- any legacy popup-only `soundEnabled` write

It does not invalidate snapshots for coordinated writes from `sa.mute.js`.
Classification is delegated to `sa.mute.isMuteOperationChange(changes)`.

### `sa.bootstrap.js`

Loads persisted settings at startup:

- `soundEnabled`
- legacy `heartbeatEnabled` migration into `soundEnabled`
- `breathingEnabled`
- `overlayPosition`
- `volumeMultiplier`
- `collapsed`

It only initializes state; live updates are handled by `sa.storage-sync.js`.

### `content.js`

Main orchestrator. It owns:

- volatile runtime state
- cached Lichess DOM references
- polling loop
- game page detection
- clock reading
- result detection
- coordination between audio, overlay, storage sync, hotkeys, bootstrap

It should ideally become smaller over time, but it is still the source of truth
for live game state.

Important runtime state in `content.js`:

- `active`: true while the current page is a live game.
- `soundEnabled`: persisted master audio toggle.
- `breathingEnabled`: persisted breathing-layer toggle.
- `volumeMultiplier`: persisted master gain multiplier.
- `collapsed`: persisted overlay mini-mode.
- `panicked`: volatile panic mute; never persisted.
- `totalTime`, `myTime`, `opponentTime`, `bpm`: clock/audio model.
- `overlayPosition`: persisted overlay position.
- `liveGameObserved`: prevents replaying result jingles on already-finished
  games after reload/navigation.

## Persisted Storage Keys

`chrome.storage.local` keys currently used:

- `soundEnabled`: master audio on/off.
- `breathingEnabled`: breathing layer on/off.
- `volumeMultiplier`: master volume, clamped between config min/max.
- `collapsed`: overlay mini-mode.
- `overlayPosition`: overlay `{ x, y }`.
- `volumeBeforeMute`: owned by `sa.mute.js`.
- `breathingBeforeMute`: owned by `sa.mute.js`.
- `heartbeatEnabled`: legacy key migrated by `sa.bootstrap.js`.

Storage survives extension reloads, version changes, and local rollbacks. If the
extension appears silent after a rollback, first check `soundEnabled` and
`volumeMultiplier` before assuming code broke.

## Audio Behavior

During a live game:

- heartbeat starts when `soundEnabled && active && !panicked`
- breathing starts when `soundEnabled && breathingEnabled && active && !panicked`
- critical beeps start when either clock is below `CRITICAL_THRESHOLD` and
  `soundEnabled`
- result jingles play only if the live game was observed in this session

Result jingle rules:

- `1-0` / `0-1` are mapped to win/loss using detected username/color.
- `1/2-1/2` is treated as draw.
- Result sound is delayed by `RESULT_DELAY_MS`.
- Already-finished games loaded fresh should stay silent.

## Overlay Behavior

The overlay appears only on detected Lichess game pages.

Default position:

- if `overlayPosition` exists, use it.
- otherwise try to place the overlay to the left of the board.
- fallback to a visible fixed position if the board cannot be measured yet.

Mini mode:

- clicking the title heart collapses.
- clicking the collapsed heart expands.
- drag works in both expanded and collapsed mode.
- current implementation persists a single `overlayPosition` for both modes.

Visual state classes:

- `sa-collapsed`: mini mode.
- `sa-panic`: panic mode active.
- `sa-muted`: master audio off (`soundEnabled=false`).

## Known Design Choices

- No service worker is needed for audio/mute coordination.
- No shared in-memory flags across popup/content scripts.
- Popup checkbox and `M` hotkey must remain semantically aligned through
  `sa.mute.js`.
- Critical beeps intentionally remain audible during panic mode.
- Panic mode is live-game-only and volatile.
- Storage sync listener has side effects on mute snapshots; review it carefully
  before changing storage writes.

## Future Refactor Candidates

Most valuable next extraction:

- `sa.game-state.js`: game page detection, clock reading, username/color
  detection, result detection, `isGameRunning`, `isGameOver`,
  `ensureTotalTime`.

Potential polish:

- Move `STAYIN_ALIVE_CONFIG` under `window.STAYIN_ALIVE.config` for namespace
  consistency.
- Decide whether `sa.utils.js` is worth keeping if it remains only `clamp`.
- Decide whether `calculateBPM` should read config directly or keep explicit
  BPM bounds.

## Change Checklist

Before committing a change:

1. Run `node --check` on changed `.js` files.
2. Reload the extension in the browser.
3. Open a new Lichess tab after reloading the extension.
4. Check popup `Audio feedback` state if audio seems silent.
5. Test at least: overlay visible, `M`, `H`, `+/-`, slider, collapse/expand,
   live heartbeat, and result jingle when relevant.
6. Confirm `svn status` only shows intended files.
