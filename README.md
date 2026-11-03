# Modular Audio

A browser modular synthesizer for phone and desktop, served at kas.dog/modularaudio.

Plain Web Audio with AudioWorklets and no build step: open `index.html` through any static server (worklets need `http://localhost` or HTTPS, not `file://`).

## Using it
- **Add modules** from the browser on the left (the ☰ button on phones).
- **Patch** by dragging from one jack to another, or tap an output then an input. Drag a plugged input to move or unplug its cable.
- **Hold or right-click a jack** to list its cables, change their gain, or delete them. Tap a cable for its gain popup.
- **Sliders:** hold <kbd>Shift</kbd> while dragging for very fine adjustment (1/25 speed), or slide your finger away from the slider on touch screens. Arrow keys nudge (Shift for finer), click a value to type it, double-tap a label to reset, and use the lock icon to protect a setting.
- **Pan** by dragging the background, **zoom** with pinch or Ctrl/⌘ + scroll; the frame icon fits the patch to the screen.
- The patch saves automatically in the browser. Settings → Download/Upload Preset for files.

## Signal conventions
- **Audio:** ±1. **CV:** 1.0 = one octave on pitch and filter cutoff inputs. **Gates:** high above 0.5.
- Pitch CV 0 = the oscillator's own note; Keys and Sequencer output 0 for C4.
- Every cable has its own gain (−2 to +2), so it doubles as an attenuverter.

## Layout
- `js/audio.js` — AudioContext, master chain, worklet loading
- `js/worklets/processors.js` — LFO, ADSR, Clock and Sequencer processors
- `js/patch.js` — module and connection model, save/load
- `js/workspace.js`, `js/cables.js` — pan/zoom, dragging, cable drawing and patching
- `js/controls.js` — fine-adjust slider, selects, locks, pitch control
- `js/modules/` — module definitions (one `registerModule` call each)
