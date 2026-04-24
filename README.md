# Stayin' Alive

Audio feedback extension for Lichess chess clocks: feel the time pressure without looking at the clock.

Works on Opera, Chrome and any Chromium-based browser (Manifest V3).

## What you hear

- **Heartbeat**: lub-dub sine pulse whose BPM (40 to 180) depends on the ratio between your clock and the opponent's, and whose volume grows with the absolute time remaining.
- **Breathing**: organic rhythmic whoosh (filtered noise + LFO) that fades in as the clock runs low and attenuates when you are far ahead. Optional, controlled by the small toggle in the overlay.
- **Critical beep**: urgent square-wave pulses under 5 seconds. High pitch (880 Hz, fast) for your own clock, low pitch (330 Hz, slower) for the opponent's.
- **Result jingle**: victory / defeat / draw chords played one second after the game ends, and only when the game was witnessed live (no surprise jingle when reloading the page of an already-finished game).

## The overlay

A small widget appears in the top-left corner of every game page. It contains:

- A **title bar** with a heart glyph, the word "Stayin' Alive", and a small toggle for the breathing layer.
- A **BPM readout** that updates in real time as the clock pressure changes.
- A **volume slider** on the right side: drag the red cursor up for louder, down for quieter (range 0% to 200% of the default level). A numeric readout appears next to the cursor while you drag or nudge it.
- A **drag handle**: grab the title bar and move the overlay anywhere on the page. The position is saved across reloads.
- A **mini mode**: click the heart glyph to collapse the overlay into a tiny round puck (just the heart). Click again to expand. The collapsed position is saved separately from the expanded one, so each layout remembers its own spot.
- **Theme awareness**: the overlay adapts its colours to the active Lichess theme (light, dark, transparent and custom themes).

## Keyboard hotkeys

When the overlay is on the page, the following keys work globally (they are ignored while typing in chat or any other input field):

| Key       | Action                                                       |
| --------- | ------------------------------------------------------------ |
| `Space`   | **Panic mute**: instantly silences all live audio. Press again to resume. |
| `H`       | Toggle the breathing layer on/off (same as the small switch in the title bar). |
| `M`       | **True mute**: saves the current volume and breath state, sets volume to 0 and disables both sound and breath. Press `M` again to restore exactly what was there before. |
| `+` / `-` | Nudge the volume up or down by one step. The numeric readout flashes briefly so you can see the new level. |

A few details about `M`:

- The restore is invalidated as soon as you touch the slider or the breath toggle yourself. The next `M` then performs a fresh mute instead of an outdated restore.
- The original breath state is sticky across consecutive mutes, so a second `M` always returns the breath toggle to the value the user last chose deliberately.

## Popup

Clicking the extension icon opens a minimal popup with a single master sound checkbox, mirrored to the overlay in real time.

## Installation

Not yet published on any store. Install in developer mode:

1. Download the latest release ZIP from the [Releases](../../releases) page (or clone this repository).
2. Open `opera://extensions` (or `chrome://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Open a Lichess game. The overlay appears in the top-left corner. Click anywhere on the page once to unlock audio (browser autoplay policy).

## How the audio reacts

| Signal           | Drives                                       | Range         | Waveform                      |
| ---------------- | -------------------------------------------- | ------------- | ----------------------------- |
| Heartbeat BPM    | `myTime / oppTime` ratio (log scale)         | 40 to 180 BPM | sine 55 Hz + 75 Hz            |
| Heartbeat volume | absolute time remaining (urgency²)           | 0.15 to 0.80  |                               |
| Breathing volume | urgency³, attenuated at 2× or more advantage | 0 to 0.12     | band-passed white noise + LFO |
| Critical beep    | any clock at 5 s or less                     | fixed 0.10    | square 880 Hz / 330 Hz        |

End-of-game jingles:

- **Win**: Do-Mi-Sol (523 / 659 / 784 Hz), last note sustained (ratio 1-1-4)
- **Loss**: Sol-Sol-Sol-Mi♭ (392 / 392 / 392 / 311 Hz), last note sustained (ratio 1-1-1-3)
- **Draw**: Sol2-Sol2-Sol2 (196 Hz), last note sustained (ratio 1-1-2)

## Settings persistence

All preferences are stored in `chrome.storage.local` and synchronised in real time across tabs, popup and overlay:

- Master sound enabled
- Breathing enabled
- Volume multiplier (0 to 2.0)
- Overlay position (expanded layout)
- Mini-mode position (collapsed layout)
- Mini-mode state (collapsed or expanded)

The previous volume and breath state, used by the `M` key to restore after a true mute, are kept here too and removed automatically when no longer needed.

## Privacy

- No network requests.
- No analytics, no tracking, no telemetry.
- The single required permission is `storage`.
- Fully synthesized audio: no bundled sound files, zero external dependencies.

## License

Distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE).

Copyright (C) 2026 LBSoft
