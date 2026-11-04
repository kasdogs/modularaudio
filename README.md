# Modular Audio

A browser modular synthesizer for phone and desktop, served at kas.dog/modularaudio.

Plain Web Audio with AudioWorklets and no build step: open `index.html` through any static server (worklets need `http://localhost` or HTTPS, not `file://`).

## Using it
- **Add modules** from the browser on the left (the ☰ button on phones). Press <kbd>/</kbd> (or <kbd>Ctrl/⌘ K</kbd>, which also works while a Keys module is using <kbd>/</kbd> as a note) to search by name or by synth terms (vcf, echo, envelope…); <kbd>Enter</kbd> adds the top match, arrow keys move through results.
- **Patch** by dragging from one jack to another, or tap an output then an input. Drag a plugged input to move or unplug its cable.
- **Hold or right-click a jack** to list its cables, change their gain, or delete them. Tap a cable for its gain popup.
- **Sliders:** hold <kbd>Shift</kbd> while dragging for very fine adjustment (1/25 speed), or slide your finger away from the slider on touch screens. Arrow keys nudge (Shift for finer), click a value to type it, double-tap a label to reset, and use the lock icon to protect a setting.
- **Pan** by dragging the background, **zoom** with pinch or Ctrl/⌘ + scroll; the frame icon fits the patch to the screen.
- **Quick add:** double-click (double-tap) empty space, type, Enter. The module lands there with no cables added.
- **Jack readouts:** hover a jack to see its live value (gate state, CV value and nearest note, audio peak); on touch, hold the jack.
- The patch saves automatically in the browser. Settings → Download/Upload Preset for `.patch.json` files.

## Editing
| | |
|---|---|
| Undo / redo | <kbd>Ctrl/⌘ Z</kbd> · <kbd>Ctrl Y</kbd> or <kbd>⇧⌘Z</kbd> (header buttons on touch). Imports, clears and share links are undoable too. |
| Select | Click a module header; <kbd>Shift</kbd>/<kbd>Ctrl</kbd>-click to add; <kbd>Shift</kbd>-drag on empty space for a box. On touch: Edit menu → Select mode. |
| Clipboard | <kbd>Ctrl C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> use the real clipboard (works between tabs); <kbd>Ctrl D</kbd> duplicates; <kbd>Del</kbd> deletes; <kbd>Ctrl A</kbd> selects all. |
| Subpatches | Edit menu → *Export selection as subpatch* writes `name.subpatch.json` (`"kind": "subpatch"`). *Add Subpatch* **adds** it to the current patch; it never replaces anything, even through Upload Preset. Full patches are refused by Add Subpatch. |
| Share links | Edit menu (or Settings) → *Copy share link*: the whole patch, compressed into the URL. Loaded samples are not included. |

## Audio files
- **Sample library:** files loaded into Sampler, Granular or Conv Reverb are stored in this browser (IndexedDB, de-duplicated by content hash) and come back after reloads, undo, paste and preset loads. Each of those modules has a *Library* menu; Settings shows the total and can clear it.
- **Recorder:** records its input to a 48 kHz WAV (16/24-bit PCM or 32-bit float, stereo or mono), resampled with the browser's resampler when the device runs at another rate.
- **MIDI In:** pick a device (Chrome, Edge, Firefox; Safari has no Web MIDI). For chords, add several MIDI In modules with the same *Polyphony group* size and give each a different *Voice*.

## Keys
Two octaves in tracker layout, by physical key position (works on any keyboard language):
- Low octave: <kbd>Z</kbd>…<kbd>/</kbd> white keys, <kbd>A</kbd>…<kbd>'</kbd> row black keys (S D · G H J · L ;).
- High octave: <kbd>Q</kbd>…<kbd>]</kbd> white keys, <kbd>1</kbd>…<kbd>=</kbd> row black keys (2 3 · 5 6 7 · 9 0 · =).
- **Scale Lock** snaps every note to Ionian, Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian or a Custom scale in any key (ties snap down). For Custom, press *Edit Scale* and click keys to add or remove notes.

## Drum Sampler and kits
`kits/<hardware name>/<audio files>` (for example `kits/roland tr77/Roland_TR-77_Kick.wav`). The Drum Sampler's first menu picks the kit, the second the sample; ◀ ▶ step through a kit with a preview. See `kits/README.md`.
- Browsers can't list folders on GitHub Pages, so the module reads `kits/index.json`. Pushing or uploading files to `kits/` rebuilds it (`.github/workflows/kits-index.yml`); or run `python3 _tools/build_kits_index.py`.
- Controls: Tune, Decay (Natural = play to the end), Attack, Start offset, Tone (low-pass ↔ high-pass), Drive, Pan, Accent Depth, Level, Direction, Retrigger (mono/poly), Choke Group (shared across modules; hats join Group A automatically), Preview on Select. Inputs: Trig, Accent, Pitch (1V/oct, sampled per hit).

## Signal conventions
- **Audio:** ±1. **CV:** 1.0 = one octave on pitch and filter cutoff inputs. **Gates:** high above 0.5.
- Pitch CV 0 = the oscillator's own note; Keys and Sequencer output 0 for C4.
- Every cable has its own gain (−2 to +2), so it doubles as an attenuverter.
- Feedback is allowed: a cable that closes a loop is drawn dashed and delayed by one audio block (128 samples), as Web Audio requires.

## Tests
`_tests/` holds an automated suite (boot, every module at extreme settings, timing, save/load, bad presets, feedback, undo/redo, clipboard, subpatches, share links, MIDI with a mock device, Recorder WAV output, drums, granular, stereo, sample library, readouts).
- In a browser: serve the repo root (`python3 -m http.server`) and open `http://localhost:8000/_tests/`.
- Headless: `pip install playwright && playwright install chromium`, then `python3 _tests/run.py` (exits non-zero on failure).

The folder is **not published**: GitHub Pages (Jekyll) skips folders that start with an underscore. Keep it that way: adding a `.nojekyll` file would publish it.

## Layout
- `js/audio.js` — AudioContext, master chain, worklet loading
- `js/worklets/processors.js` — audio-thread processors (LFO, ADSR, clocks, sequencers, gates, logic, math, recorder…)
- `js/patch.js` — module and connection model, save/load
- `js/workspace.js`, `js/cables.js` — pan/zoom, dragging, cable drawing and patching
- `js/controls.js` — fine-adjust slider, selects, locks, pitch control
- `js/history.js`, `js/editor.js` — undo/redo, selection, clipboard, subpatches, quick add, share links
- `js/samples.js`, `js/midi.js`, `js/readouts.js` — sample library, Web MIDI, jack readouts
- `js/modules/` — module definitions (one `registerModule` call each)
