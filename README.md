# Stayin' Alive

Audio feedback extension for Lichess chess clocks — feel the time pressure without looking at the clock.

Works on Opera, Chrome and any Chromium-based browser (Manifest V3).

## Features

- **Heartbeat** — lub-dub sine pulse whose BPM (40–180) depends on the ratio between your clock and the opponent's, and whose volume grows with the absolute time remaining.
- **Breathing** — organic rhythmic whoosh (filtered noise + LFO) that fades in as the clock runs low and attenuates when you are far ahead.
- **Critical beep** — urgent square-wave pulses under 5 seconds: high pitch (880 Hz, fast) for your clock, low pitch (330 Hz, slower) for the opponent's.
- **Result jingle** — victory / defeat / draw chords played 1 s after the game ends.
- **Draggable overlay** with live BPM readout and ON/OFF toggle; position persists via `chrome.storage.local`.
- Auto-detects the time control, your username, your colour and the final result.
- Zero dependencies, fully synthesized audio (no bundled sound files).

## Installation

Not yet published on any store. Install in developer mode:

1. Clone or download this repository.
2. Open `opera://extensions` (or `chrome://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Open a Lichess game — a small widget appears in the top-left corner. Click anywhere on the page once to unlock audio (browser autoplay policy).

## How the audio reacts

| Signal           | Drives             | Range         | Waveform                     |
|------------------|--------------------|---------------|------------------------------|
| Heartbeat BPM    | `myTime / oppTime` ratio (log scale) | 40–180 BPM | sine 55 Hz + 75 Hz  |
| Heartbeat volume | absolute time remaining (urgency²)    | 0.15–0.80 | — |
| Breathing volume | urgency³, attenuated ≥2× advantage    | 0–0.12    | band-passed white noise + LFO |
| Critical beep    | any clock ≤ 5 s                        | fixed 0.10 | square 880 Hz / 330 Hz |

## Privacy

- No network requests.
- No analytics, no tracking, no telemetry.
- `chrome.storage.local` is used for exactly two preferences: sound toggle and overlay position.
- The single required permission is `storage`.

## License

Distributed under the GNU General Public License v3.0 — see [LICENSE](LICENSE).

Copyright (C) 2026 LBSoft
