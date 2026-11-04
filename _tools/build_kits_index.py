#!/usr/bin/env python3
"""Build kits/index.json for the Drum Sampler.

Layout:  kits/<hardware name>/<audio files>
         e.g. kits/roland tr77/Roland_TR-77_Kick.wav

GitHub Pages can't list folders, so the app reads this index instead.
Run after adding or removing samples:   python3 _tools/build_kits_index.py
(The GitHub Action in .github/workflows/kits-index.yml runs it automatically on push.)
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KITS = os.path.join(ROOT, "kits")
AUDIO = {".wav", ".wave", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".oga", ".opus", ".m4a"}

# Words in a file name that identify the drum, in priority order.
CATEGORIES = [
    ("kick", r"kick|bd|bassdrum|bass drum|kik"), ("snare", r"snare|sd|snr"), ("clap", r"clap|cp|handclap"),
    ("rim", r"rim|rs|sidestick|side stick"), ("closed hat", r"closed|chh|ch\b|hh\b|hihat|hi-hat|hi hat|hat"),
    ("open hat", r"open|ohh|oh\b"), ("tom", r"tom|tm|lt\b|mt\b|ht\b"), ("cymbal", r"cymbal|crash|ride|cy\b|cym"),
    ("cowbell", r"cow|cb\b|bell"), ("conga", r"conga|bongo|cg\b|timbale"), ("shaker", r"shak|maraca|cabasa|tamb"),
    ("perc", r"perc|clave|cl\b|block|guiro|whistle|agogo"),
]

def natural(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

def category(name):
    n = name.lower().replace("_", " ").replace("-", " ")
    if re.search(r"open", n) and re.search(r"hat|hh", n): return "open hat"
    for cat, pat in CATEGORIES:
        if re.search(rf"(^|\b|\s)({pat})", n): return cat
    return "other"

def display_names(files):
    """Strip the prefix shared by every file in a kit (e.g. 'Roland_TR-77_') and the extension."""
    stems = [os.path.splitext(f)[0] for f in files]
    if len(stems) > 1:
        prefix = os.path.commonprefix(stems)
        cut = max(prefix.rfind("_"), prefix.rfind(" "), prefix.rfind("-"))
        if cut > 0: stems = [s[cut + 1:] or s for s in stems]
    return [s.replace("_", " ").strip() for s in stems]

def build():
    kits = []
    if os.path.isdir(KITS):
        for folder in sorted(os.listdir(KITS), key=natural):
            path = os.path.join(KITS, folder)
            if not os.path.isdir(path) or folder.startswith((".", "_")): continue
            files = sorted((f for f in os.listdir(path) if os.path.splitext(f)[1].lower() in AUDIO and not f.startswith(".")), key=natural)
            if not files: continue
            names = display_names(files)
            samples = [{"file": f, "name": n, "category": category(n)} for f, n in zip(files, names)]
            kits.append({"name": folder, "folder": folder, "samples": samples})
    return {"version": 1, "kits": kits}

if __name__ == "__main__":
    data = build()
    out = os.path.join(KITS, "index.json")
    os.makedirs(KITS, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    old = open(out, encoding="utf-8").read() if os.path.exists(out) else None
    if old != text:
        open(out, "w", encoding="utf-8").write(text)
    n = sum(len(k["samples"]) for k in data["kits"])
    print(f"kits/index.json: {len(data['kits'])} kits, {n} samples{' (unchanged)' if old == text else ''}")
