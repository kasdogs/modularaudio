// Shared helpers: DOM, formatting, music maths.

export function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const noteToMidi = (name, octave) => NOTE_NAMES.indexOf(name) + (octave + 1) * 12;
export function midiToName(m) {
    const r = Math.round(m);
    return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}
export function nearestNote(freq) {
    const m = Math.round(freqToMidi(freq));
    return { name: NOTE_NAMES[((m % 12) + 12) % 12], octave: Math.floor(m / 12) - 1, midi: m };
}

export function formatFrequency(f) {
    if (!Number.isFinite(f)) return '—';
    if (f < 0.1) return `${f.toFixed(3)} Hz`;
    if (f < 10) return `${f.toFixed(2)} Hz`;
    if (f < 1000) return `${f.toFixed(1)} Hz`;
    return `${(f / 1000).toFixed(2)} kHz`;
}
export function formatTime(s) {
    if (s < 1) return `${(s * 1000).toFixed(s < 0.01 ? 1 : 0)} ms`;
    return `${s.toFixed(2)} s`;
}
export const formatDb = (db) => (db <= -60 ? '-∞ dB' : `${db.toFixed(1)} dB`);
export const formatPercent = (v) => `${Math.round(v * 100)}%`;
export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0.001 ? -60 : 20 * Math.log10(g));

export function lockIcon(locked) {
    const path = locked
        ? 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'
        : 'M18 10V7a4 4 0 00-8 0v3M4 14h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2z';
    return `<svg xmlns="http://www.w3.org/2000/svg" class="param-lock${locked ? ' locked' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('visible'), ms);
}

// True when keyboard focus is in a text field (so shortcuts stay out of the way).
export function typingInField() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' && a.type !== 'range' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

// Set a .meter-fill element to a 0..1 level.
export function setMeter(fill, v) { fill.style.setProperty('--v', String(Math.max(0, Math.min(1, v)))); }
