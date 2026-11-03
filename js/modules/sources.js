// Sound and control sources: Oscillator, LFO, Noise, Keys.
import { registerModule } from '../patch.js';
import { el, formatFrequency, formatDb, dbToGain, NOTE_NAMES, midiToName, typingInField } from '../util.js';
import { PITCH_PARAMS } from '../controls.js';

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

// --- Keys: on-screen and QWERTY keyboard ---
const QWERTY = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
const keysModules = new Set();
const heldQwerty = new Set();
window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typingInField()) return;
    const k = e.key.toLowerCase();
    const i = QWERTY.indexOf(k);
    if (i >= 0) { heldQwerty.add(k); keysModules.forEach((km) => km.press(i, 'kb')); return; }
    if (k === 'z' || k === 'x') keysModules.forEach((km) => km.shiftOctave(k === 'z' ? -1 : 1));
});
window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    const i = QWERTY.indexOf(k);
    if (i >= 0 && heldQwerty.delete(k)) keysModules.forEach((km) => km.release(i, 'kb'));
});
window.addEventListener('blur', () => { heldQwerty.clear(); keysModules.forEach((km) => km.releaseAll()); });

registerModule({
    type: 'keys', title: 'Keys', category: 'Sources', blurb: 'Play notes: touch or A–K on a keyboard',
    width: 240,
    params: {
        octave: { label: 'Octave', min: 0, max: 8, default: 4, step: 1, format: (v) => `C${v}` },
        glide: { label: 'Glide', min: 0, max: 1, default: 0, curve: 3, format: (v) => (v < 0.001 ? 'Off' : `${Math.round(v * 1000)} ms`) },
    },
    create(m, ctx) {
        const pitch = ctx.createConstantSource(); pitch.offset.value = 0; pitch.start();
        const gate = ctx.createConstantSource(); gate.offset.value = 0; gate.start();
        const keysEl = el('div', { class: 'keys' });
        const whites = [0, 2, 4, 5, 7, 9, 11, 12];
        const keyEls = [];
        const ww = 100 / whites.length;
        for (let s = 0; s <= 12; s++) {
            const white = whites.includes(s);
            const k = el('div', { class: `key ${white ? 'white' : 'black'}`, dataset: { semi: s } });
            if (white) {
                const wi = whites.indexOf(s);
                Object.assign(k.style, { left: `${wi * ww}%`, width: `${ww}%` });
                k.append(el('span', { class: 'key-label', text: QWERTY[s].toUpperCase() }));
            } else {
                const wi = whites.indexOf(s - 1);
                Object.assign(k.style, { left: `${(wi + 1) * ww - ww * 0.32}%`, width: `${ww * 0.64}%` });
            }
            keyEls[s] = k;
            keysEl.append(k);
        }
        const readout = el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Note' }), el('strong', { text: '—' }));
        m.content.append(keysEl, readout);
        m.slider('octave');
        m.slider('glide');
        const stack = []; // held semitones, most recent last
        const setNote = (semi) => {
            const midi = (m.params.octave + 1) * 12 + semi;
            const t = ctx.currentTime;
            const v = (midi - 60) / 12; // C4 = 0
            pitch.offset.cancelScheduledValues(t);
            if (m.params.glide > 0.001 && gate.offset.value > 0.5) { pitch.offset.setValueAtTime(pitch.offset.value, t); pitch.offset.setTargetAtTime(v, t, m.params.glide / 3); }
            else pitch.offset.setValueAtTime(v, t);
            readout.lastChild.textContent = midiToName(midi);
        };
        const gateOn = (retrigger) => {
            const t = ctx.currentTime;
            gate.offset.cancelScheduledValues(t);
            if (retrigger) { gate.offset.setValueAtTime(0, t); gate.offset.setValueAtTime(1, t + 0.002); }
            else gate.offset.setValueAtTime(1, t);
        };
        const api = {
            press(semi, src) {
                if (stack.includes(semi)) return;
                stack.push(semi);
                keyEls[semi].classList.add('down');
                setNote(semi);
                gateOn(m.params.glide <= 0.001);
            },
            release(semi) {
                const i = stack.indexOf(semi);
                if (i < 0) return;
                stack.splice(i, 1);
                keyEls[semi].classList.remove('down');
                if (stack.length) setNote(stack[stack.length - 1]);
                else { gate.offset.cancelScheduledValues(ctx.currentTime); gate.offset.setValueAtTime(0, ctx.currentTime); }
            },
            releaseAll() { [...stack].forEach((s) => api.release(s)); },
            shiftOctave(d) { m.setParam('octave', Math.min(8, Math.max(0, m.params.octave + d))); },
        };
        // Touch / mouse with glissando across keys
        const active = new Map();
        keysEl.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            keysEl.setPointerCapture(e.pointerId);
            const k = e.target.closest('.key');
            if (!k) return;
            const s = +k.dataset.semi;
            active.set(e.pointerId, s);
            api.press(s);
        });
        keysEl.addEventListener('pointermove', (e) => {
            if (!active.has(e.pointerId)) return;
            const k = document.elementFromPoint(e.clientX, e.clientY)?.closest('.key');
            if (!k || !keysEl.contains(k)) return;
            const s = +k.dataset.semi;
            const prev = active.get(e.pointerId);
            if (s !== prev) { api.press(s); api.release(prev); active.set(e.pointerId, s); }
        });
        const up = (e) => {
            if (!active.has(e.pointerId)) return;
            api.release(active.get(e.pointerId));
            active.delete(e.pointerId);
        };
        keysEl.addEventListener('pointerup', up);
        keysEl.addEventListener('pointercancel', up);
        keysModules.add(api);
        m.addOutput('pitch', 'Pitch', 'cv', pitch);
        m.addOutput('gate', 'Gate', 'gate', gate);
        return {
            dispose() { keysModules.delete(api); try { pitch.stop(); gate.stop(); } catch (e) {} },
        };
    },
});

export { NOTE_NAMES };
