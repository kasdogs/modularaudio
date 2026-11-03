// Sound and control sources: Oscillator, LFO, Noise, Keys.
import { registerModule } from '../patch.js';
import { el, formatFrequency, formatDb, dbToGain, NOTE_NAMES, midiToName, typingInField } from '../util.js';
import { PITCH_PARAMS } from '../controls.js';

const stop = (e) => e.stopPropagation();
const button = (text) => { const b = el('button', { class: 'param-button', type: 'button', text }); b.addEventListener('pointerdown', stop); return b; };

// Cached custom waveforms per context
const waveCache = new WeakMap();
function revSaw(ctx) {
    let w = waveCache.get(ctx);
    if (!w) {
        const n = 64, real = new Float32Array(n), imag = new Float32Array(n);
        for (let k = 1; k < n; k++) imag[k] = (2 * Math.pow(-1, k)) / (k * Math.PI);
        w = ctx.createPeriodicWave(real, imag);
        waveCache.set(ctx, w);
    }
    return w;
}

registerModule({
    type: 'oscillator', title: 'Oscillator', category: 'Sources', blurb: 'Pitched waveform, 1V/oct pitch, FM',
    width: 210,
    params: {
        ...PITCH_PARAMS,
        wave: { label: 'Waveform', default: 'sawtooth', options: [
            { value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'sawtooth', label: 'Sawtooth' },
            { value: 'revsaw', label: 'Rev Saw' }, { value: 'square', label: 'Square' }] },
        level: { label: 'Level', min: -60, max: 0, default: -6, step: 0.1, format: formatDb, unit: 'dB' },
        fm: { label: 'FM Depth', min: 0, max: 2000, default: 100, curve: 3, format: formatFrequency, unit: 'Hz' },
    },
    create(m, ctx) {
        const osc = ctx.createOscillator();
        const out = ctx.createGain();
        const pitch = ctx.createGain(); pitch.gain.value = 1200; // 1 unit = 1 octave
        const fm = ctx.createGain();
        osc.connect(out);
        pitch.connect(osc.detune);
        fm.connect(osc.frequency);
        osc.start();
        const p = m.pitch({ min: 10, max: 20000, minOctave: -1, maxOctave: 9, label: 'Freq' });
        m.select('wave');
        m.slider('level');
        m.slider('fm');
        m.addInput('pitch', 'Pitch', 'cv', pitch);
        m.addInput('fm', 'FM', 'audio', fm);
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (['mode', 'freq', 'fine', 'note', 'octave'].includes(key)) m.set(osc.frequency, Math.min(ctx.sampleRate / 2 - 1, p.frequency()), 0.01);
                if (key === 'wave') { if (v === 'revsaw') osc.setPeriodicWave(revSaw(ctx)); else osc.type = v; }
                if (key === 'level') m.set(out.gain, dbToGain(v));
                if (key === 'fm') m.set(fm.gain, v);
            },
            refresh() { m.set(osc.frequency, Math.min(ctx.sampleRate / 2 - 1, p.frequency()), 0); },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

registerModule({
    type: 'lfo', title: 'LFO', category: 'Sources', blurb: 'Low-frequency modulation, six shapes',
    params: {
        rate: { label: 'Rate', min: 0.02, max: 50, curve: 'log', default: 1, format: formatFrequency, unit: 'Hz' },
        shape: { label: 'Shape', default: 0, options: [
            { value: 0, label: 'Sine' }, { value: 1, label: 'Triangle' }, { value: 2, label: 'Saw Up' },
            { value: 3, label: 'Saw Down' }, { value: 4, label: 'Square' }, { value: 5, label: 'Sample & Hold' }] },
        depth: { label: 'Depth', min: 0, max: 1, default: 1, format: (v) => v.toFixed(2) },
        polarity: { label: 'Range', default: 'bi', options: [{ value: 'bi', label: 'Bipolar (−1…+1)' }, { value: 'uni', label: 'Unipolar (0…1)' }] },
    },
    create(m, ctx) {
        const node = m.worklet('ma-lfo', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const depth = ctx.createGain();
        node.connect(depth);
        const led = el('span', { class: 'led' });
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Output' }), led));
        node.port.onmessage = (e) => {
            const v = Math.abs(e.data);
            led.style.opacity = String(0.25 + 0.75 * Math.min(1, v));
            led.classList.toggle('on', v > 0.05);
        };
        m.slider('rate');
        m.select('shape');
        m.slider('depth');
        m.select('polarity');
        m.addInput('rate', 'Rate', 'cv', node.parameters.get('rateCv'));
        m.addInput('depth', 'Depth', 'cv', depth.gain);
        m.addInput('reset', 'Reset', 'gate', node);
        m.addOutput('out', 'Out', 'cv', depth);
        return {
            update(key, v) {
                if (key === 'rate') m.set(node.parameters.get('rate'), v, 0.01);
                if (key === 'shape') node.parameters.get('shape').value = v;
                if (key === 'depth') m.set(depth.gain, v);
                if (key === 'polarity') node.parameters.get('unipolar').value = v === 'uni' ? 1 : 0;
            },
            dispose() { node.port.onmessage = null; },
        };
    },
});

// Noise buffers are generated once per context and colour.
const noiseCache = new WeakMap();
function noiseBuffer(ctx, color) {
    let c = noiseCache.get(ctx);
    if (!c) { c = {}; noiseCache.set(ctx, c); }
    if (c[color]) return c[color];
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (color === 'pink') {
            // Paul Kellet's refined pink filter
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
            b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
            d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
            b6 = w * 0.115926;
        } else if (color === 'brown') {
            last = (last + 0.02 * w) / 1.02;
            d[i] = last * 3.5;
        } else d[i] = w * 0.5;
    }
    c[color] = buf;
    return buf;
}

registerModule({
    type: 'noise', title: 'Noise', category: 'Sources', blurb: 'White, pink or brown noise',
    params: {
        color: { label: 'Colour', default: 'white', options: [{ value: 'white', label: 'White' }, { value: 'pink', label: 'Pink' }, { value: 'brown', label: 'Brown' }] },
        level: { label: 'Level', min: -60, max: 0, default: -12, step: 0.1, format: formatDb, unit: 'dB' },
    },
    create(m, ctx) {
        const out = ctx.createGain();
        let src = null;
        const start = (color) => {
            const s = ctx.createBufferSource();
            s.buffer = noiseBuffer(ctx, color);
            s.loop = true;
            s.connect(out);
            s.start(0, Math.random() * 3);
            if (src) { try { src.stop(); src.disconnect(); } catch (e) {} }
            src = s;
        };
        m.select('color');
        m.slider('level');
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'color') start(v);
                if (key === 'level') m.set(out.gain, dbToGain(v));
            },
            dispose() { try { src && src.stop(); } catch (e) {} },
        };
    },
});

// --- Keys: two-octave on-screen and computer keyboard (tracker layout), with scale lock ---
// Physical key positions (KeyboardEvent.code), so the layout works on any keyboard language.
// Low octave: Z row = white keys, A row = black keys. High octave: Q row = white, number row = black.
const KEYMAP = {
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
    Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
    KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31,
};
// Label shown on each on-screen key (low row for the first octave, Q row for the second).
const KEY_LABELS = ['Z', 'S', 'X', 'D', 'C', 'V', 'G', 'B', 'H', 'N', 'J', 'M', 'Q', '2', 'W', '3', 'E', 'R', '5', 'T', '6', 'Y', '7', 'U', 'I'];
export const SCALES = {
    chromatic: null,
    ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
};
const SCALE_OPTIONS = [
    { value: 'chromatic', label: 'Off (chromatic)' }, { value: 'ionian', label: 'Ionian (major)' }, { value: 'dorian', label: 'Dorian' },
    { value: 'phrygian', label: 'Phrygian' }, { value: 'lydian', label: 'Lydian' }, { value: 'mixolydian', label: 'Mixolydian' },
    { value: 'aeolian', label: 'Aeolian (natural minor)' }, { value: 'locrian', label: 'Locrian' }, { value: 'custom', label: 'Custom (pick notes)' },
];
// Pitch classes (0 = C) allowed by a scale setting.
export function allowedSet(scale, root, mask) {
    if (scale === 'chromatic') return null;
    if (scale === 'custom') return new Set(mask.map((on, pc) => (on ? pc : -1)).filter((pc) => pc >= 0));
    return new Set(SCALES[scale].map((i) => (i + root) % 12));
}
// Move a MIDI note to the nearest allowed note (ties go down). Returns null when nothing is allowed.
export function snapNote(note, allowed) {
    if (!allowed) return note;
    if (!allowed.size) return null;
    for (let d = 0; d < 12; d++) {
        if (allowed.has(((note - d) % 12 + 12) % 12)) return note - d;
        if (allowed.has(((note + d) % 12 + 12) % 12)) return note + d;
    }
    return note;
}

const keysModules = new Set();
const heldCodes = new Set();
window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typingInField()) return;
    const semi = KEYMAP[e.code];
    if (semi === undefined || !keysModules.size) return;
    e.preventDefault();
    heldCodes.add(e.code);
    keysModules.forEach((km) => km.press(semi, e.code));
});
window.addEventListener('keyup', (e) => {
    if (!heldCodes.delete(e.code)) return;
    keysModules.forEach((km) => km.release(e.code));
});
window.addEventListener('blur', () => { heldCodes.clear(); keysModules.forEach((km) => km.releaseAll()); });
export const keysActive = () => keysModules.size > 0;

registerModule({
    type: 'keys', title: 'Keys', category: 'Sources', blurb: 'Two octaves: touch, or Z/A and Q/1 key rows', width: 340,
    params: {
        octave: { label: 'Octave', min: 0, max: 7, default: 3, step: 1, format: (v) => `C${v}–C${v + 2}` },
        glide: { label: 'Glide', min: 0, max: 1, default: 0, curve: 3, format: (v) => (v < 0.001 ? 'Off' : `${Math.round(v * 1000)} ms`) },
        scale: { label: 'Scale Lock', default: 'chromatic', options: SCALE_OPTIONS },
        root: { label: 'Key', default: 0, options: NOTE_NAMES.map((n, i) => ({ value: i, label: n })) },
        mask: { default: Array(12).fill(true) },
    },
    create(m, ctx) {
        const pitch = ctx.createConstantSource(); pitch.offset.value = 0; pitch.start();
        const gate = ctx.createConstantSource(); gate.offset.value = 0; gate.start();
        const keysEl = el('div', { class: 'keys two' });
        const WHITE = [0, 2, 4, 5, 7, 9, 11];
        const whites = [];
        for (let s = 0; s <= 24; s++) if (WHITE.includes(s % 12)) whites.push(s);
        const ww = 100 / whites.length;
        const keyEls = [];
        for (let s = 0; s <= 24; s++) {
            const white = WHITE.includes(s % 12);
            const k = el('div', { class: `key ${white ? 'white' : 'black'}`, dataset: { semi: s } }, el('span', { class: 'key-label', text: KEY_LABELS[s] || '' }));
            if (white) Object.assign(k.style, { left: `${whites.indexOf(s) * ww}%`, width: `${ww}%` });
            else Object.assign(k.style, { left: `${(whites.indexOf(s - 1) + 1) * ww - ww * 0.32}%`, width: `${ww * 0.64}%` });
            keyEls[s] = k;
            keysEl.append(k);
        }
        const down = button('−'), up = button('+'), edit = button('Edit Scale');
        down.title = 'Octave down'; up.title = 'Octave up';
        edit.title = 'Click keys to add or remove notes from the custom scale';
        const readout = el('strong', { text: '—' });
        const scaleInfo = el('span', { class: 'node-label' });
        m.content.append(keysEl,
            el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Note' }), readout),
            el('div', { class: 'btn-row' }, down, up, edit));
        const grid = el('div', { class: 'two-col' });
        m.content.append(grid);
        m.select('scale', grid);
        m.select('root', grid);
        m.content.append(el('div', { class: 'info-row' }, scaleInfo));
        m.slider('octave');
        m.slider('glide');
        let editing = false;
        const allowed = () => allowedSet(m.params.scale, Number(m.params.root), m.params.mask);
        const stack = []; // [{ code, semi }], most recent last
        const outNote = (semi) => snapNote((m.params.octave + 1) * 12 + semi, allowed());
        const setNote = (semi) => {
            const n = outNote(semi);
            if (n === null) return false;
            const t = ctx.currentTime, v = (n - 60) / 12; // C4 = 0
            pitch.offset.cancelScheduledValues(t);
            if (m.params.glide > 0.001 && gate.offset.value > 0.5) { pitch.offset.setValueAtTime(pitch.offset.value, t); pitch.offset.setTargetAtTime(v, t, m.params.glide / 3); }
            else pitch.offset.setValueAtTime(v, t);
            const played = (m.params.octave + 1) * 12 + semi;
            readout.textContent = n === played ? midiToName(n) : `${midiToName(played)} → ${midiToName(n)}`;
            return true;
        };
        const gateOn = (retrigger) => {
            const t = ctx.currentTime;
            gate.offset.cancelScheduledValues(t);
            if (retrigger) { gate.offset.setValueAtTime(0, t); gate.offset.setValueAtTime(1, t + 0.002); } else gate.offset.setValueAtTime(1, t);
        };
        const paint = () => {
            const set = allowed(), root = Number(m.params.root);
            keyEls.forEach((k, s) => {
                const pc = s % 12;
                k.classList.toggle('out-of-scale', !!set && !set.has(pc));
                k.classList.toggle('root', !!set && m.params.scale !== 'custom' && pc === root);
                k.classList.toggle('editing', editing);
                k.classList.toggle('down', stack.some((h) => h.semi === s));
            });
            edit.classList.toggle('active', editing);
            edit.classList.toggle('hidden', m.params.scale !== 'custom');
            m.controls.root && m.controls.root.el.classList.toggle('hidden', m.params.scale === 'chromatic' || m.params.scale === 'custom');
            const names = set ? [...set].sort((a, b) => ((a - root + 12) % 12) - ((b - root + 12) % 12)).map((pc) => NOTE_NAMES[pc]) : null;
            scaleInfo.textContent = !set ? 'All 12 notes' : set.size ? `Notes: ${names.join(' ')}` : 'No notes selected';
        };
        const api = {
            press(semi, code) {
                if (stack.some((h) => h.code === code)) return;
                if (!setNote(semi)) return;
                stack.push({ code, semi });
                gateOn(m.params.glide <= 0.001);
                paint();
            },
            release(code) {
                const i = stack.findIndex((h) => h.code === code);
                if (i < 0) return;
                stack.splice(i, 1);
                if (stack.length) setNote(stack[stack.length - 1].semi);
                else { gate.offset.cancelScheduledValues(ctx.currentTime); gate.offset.setValueAtTime(0, ctx.currentTime); }
                paint();
            },
            releaseAll() { [...stack].forEach((h) => api.release(h.code)); },
        };
        // Touch / mouse with glissando; in Edit Scale mode a tap toggles that note.
        const active = new Map();
        keysEl.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const k = e.target.closest('.key');
            if (!k) return;
            const s = +k.dataset.semi;
            if (editing) {
                const mask = [...m.params.mask];
                mask[s % 12] = !mask[s % 12];
                m.setParam('mask', mask);
                return;
            }
            keysEl.setPointerCapture(e.pointerId);
            const code = `ptr${e.pointerId}`;
            active.set(e.pointerId, { s, code });
            api.press(s, code);
        });
        keysEl.addEventListener('pointermove', (e) => {
            const a = active.get(e.pointerId);
            if (!a) return;
            const k = document.elementFromPoint(e.clientX, e.clientY)?.closest('.key');
            if (!k || !keysEl.contains(k)) return;
            const s = +k.dataset.semi;
            if (s === a.s) return;
            const code = `ptr${e.pointerId}:${s}`;
            api.press(s, code);
            api.release(a.code);
            active.set(e.pointerId, { s, code });
        });
        const upH = (e) => { const a = active.get(e.pointerId); if (!a) return; api.release(a.code); active.delete(e.pointerId); };
        keysEl.addEventListener('pointerup', upH);
        keysEl.addEventListener('pointercancel', upH);
        down.addEventListener('click', () => m.setParam('octave', Math.max(0, m.params.octave - 1)));
        up.addEventListener('click', () => m.setParam('octave', Math.min(7, m.params.octave + 1)));
        edit.addEventListener('click', () => { editing = !editing; paint(); });
        keysModules.add(api);
        m.addOutput('pitch', 'Pitch', 'cv', pitch);
        m.addOutput('gate', 'Gate', 'gate', gate);
        let lastScale = m.params.scale;
        return {
            update(key, v) {
                if (key === 'scale') {
                    // Starting a custom scale copies the notes of the previous one.
                    if (v === 'custom' && lastScale !== 'custom') {
                        const prev = allowedSet(lastScale, Number(m.params.root), m.params.mask);
                        if (prev) m.params.mask = Array.from({ length: 12 }, (_, pc) => prev.has(pc));
                    }
                    if (v !== 'custom') editing = false;
                    lastScale = v;
                }
                if (key === 'mask' && (!Array.isArray(v) || v.length !== 12)) m.params.mask = Array(12).fill(true);
                if (stack.length) setNote(stack[stack.length - 1].semi);
                paint();
            },
            refresh: paint,
            dispose() { keysModules.delete(api); try { pitch.stop(); gate.stop(); } catch (e) {} },
        };
    },
});

export { NOTE_NAMES };
