# Drum kits

Each folder is one kit, named after the hardware it was sampled from. Put the audio files directly inside:

```
kits/
  roland tr77/
    Roland_TR-77_Kick.wav
    Roland_TR-77_Snare.wav
  linn lm-1/
    ...
```

- Formats: WAV, AIFF, FLAC, MP3, OGG, Opus, M4A (WAV is the safest across browsers; Safari can't play OGG/Opus).
- The name shown in the Drum Sampler drops the prefix shared by every file in the kit (`Roland_TR-77_Kick.wav` → `Kick`).
- Words like kick, snare, clap, rim, hat/closed/open, tom, cymbal/crash/ride, cowbell, conga, shaker in a file name set its category, which picks sensible defaults (for example open hats join a choke group).

## The index
Browsers can't list folders on GitHub Pages, so the app reads `kits/index.json`.
- Pushing or uploading files to `kits/` on GitHub rebuilds it automatically (`.github/workflows/kits-index.yml`).
- Or run `python3 _tools/build_kits_index.py` before committing.

`modular audio synth/` is a starter kit rendered from the app's own Drum Voice; delete it whenever you like.
