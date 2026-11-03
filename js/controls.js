// Parameter controls: fine-adjust slider, select, lock, reset, typed values, pitch group.
import { el, clamp, lockIcon, NOTE_NAMES, noteToMidi, midiToFreq, nearestNote, formatFrequency } from './util.js';
import { settings } from './settings.js';

const DOUBLE_TAP_MS = 300;
const FINE_SCALE = 1 / 25;      // Shift-drag speed
const TOUCH_FINE_START = 36;    // px away from the slider before touch fine mode kicks in

let fineBadge = null;
function badge() {
    if (!fineBadge) { fineBadge = el('div', { class: 'fine-badge' }); document.body.append(fineBadge); }
    return fineBadge;
}
export let shiftDown = false;
window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftDown = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; });
window.addEventListener('blur', () => { shiftDown = false; });

// --- Value <-> position mapping ---
export function makeScale(spec) {
    const { min, max } = spec;
    const curve = spec.curve || 'lin';
    if (curve === 'log') {
        const a = Math.log(min), b = Math.log(max);
        return { toPos: (v) => (Math.log(clamp(v, min, max)) - a) / (b - a), toVal: (p) => Math.exp(a + p * (b - a)) };
    }
    if (typeof curve === 'number') { // power curve, >1 gives more resolution near min
        return {
            toPos: (v) => Math.pow((clamp(v, min, max) - min) / (max - min), 1 / curve),
            toVal: (p) => min + Math.pow(p, curve) * (max - min),
        };
    }
    return { toPos: (v) => (clamp(v, min, max) - min) / (max - min), toVal: (p) => min + p * (max - min) };
}

function quantize(v, spec) {
    if (spec.step) v = Math.round(v / spec.step) * spec.step;
    return clamp(v, spec.min, spec.max);
}

// --- Slider ---
export class FineSlider {
    constructor(spec, onInput) {
        this.spec = spec;
        this.scale = makeScale(spec);
        this.onInput = onInput;
        this.value = spec.default;
        this.locked = false;
        this.root = el('div', { class: 'fslider', tabindex: '0', role: 'slider', 'aria-label': spec.label || spec.key,
            'aria-valuemin': spec.min, 'aria-valuemax': spec.max });
        this.fill = el('div', { class: 'fslider-fill' });
        this.track = el('div', { class: 'fslider-track' }, this.fill);
        this.thumb = el('div', { class: 'fslider-thumb' });
        this.root.append(this.track, this.thumb);
        this.bind();
        this.render();
    }
    get pos() { return this.scale.toPos(this.value); }
    setValue(v, emit = false) {
        const q = quantize(v, this.spec);
        if (q === this.value && !emit) return;
        this.value = q;
        this.render();
        if (emit) this.onInput(q);
    }
    setPos(p, emit = true) { this.setValue(this.scale.toVal(clamp(p, 0, 1)), emit); }
    render() {
        const p = clamp(this.pos, 0, 1);
        this.thumb.style.left = `calc(9px + ${p} * (100% - 18px))`;
        // Bipolar ranges fill from the centre.
        const zero = this.spec.min < 0 && this.spec.max > 0 ? this.scale.toPos(0) : 0;
        const a = Math.min(zero, p), b = Math.max(zero, p);
        this.fill.style.left = `${a * 100}%`;
        this.fill.style.width = `${(b - a) * 100}%`;
        this.root.setAttribute('aria-valuenow', String(this.value));
    }
    setLocked(l) { this.locked = l; this.root.classList.toggle('locked', l); }
    bind() {
        const r = this.root;
        let drag = null;
        const posFromX = (x) => {
            const rect = r.getBoundingClientRect();
            return clamp((x - rect.left - 9) / Math.max(1, rect.width - 18), 0, 1);
        };
        r.addEventListener('pointerdown', (e) => {
            if (this.locked || e.button > 0) return;
            e.stopPropagation();
            e.preventDefault();
            r.focus({ preventScroll: true });
            r.setPointerCapture(e.pointerId);
            const rect = r.getBoundingClientRect();
            drag = { id: e.pointerId, lastX: e.clientX, relative: false, width: Math.max(1, rect.width - 18), touch: e.pointerType !== 'mouse' };
            const onThumb = Math.abs(e.clientX - (rect.left + 9 + this.pos * drag.width)) < 12;
            if (shiftDown || onThumb) drag.relative = true; // keep the current value; adjust from here
            else this.setPos(posFromX(e.clientX));
            r.classList.add('active');
        });
        r.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            let k = 1;
            if (shiftDown) k = FINE_SCALE;
            else if (drag.touch) {
                const rect = r.getBoundingClientRect();
                const dy = Math.abs(e.clientY - (rect.top + rect.height / 2));
                if (dy > TOUCH_FINE_START) k = Math.max(FINE_SCALE, 1 / (1 + (dy - TOUCH_FINE_START) / 25));
            }
            const fine = k < 1;
            r.classList.toggle('fine', fine);
            const b = badge();
            if (fine) {
                b.style.display = 'block';
                b.style.left = `${e.clientX}px`;
                b.style.top = `${e.clientY}px`;
                b.textContent = `Fine ×1/${Math.round(1 / k)}`;
            } else b.style.display = 'none';
            if (fine) drag.relative = true;
            if (drag.relative) {
                const dx = e.clientX - drag.lastX;
                // Work in position space but keep sub-step precision by accumulating.
                drag.acc = (drag.acc ?? this.pos) + (dx / drag.width) * k;
                drag.acc = clamp(drag.acc, 0, 1);
                this.setPos(drag.acc);
            } else {
                this.setPos(posFromX(e.clientX));
            }
            drag.lastX = e.clientX;
        });
        const end = (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            drag = null;
            r.classList.remove('active', 'fine');
            badge().style.display = 'none';
        };
        r.addEventListener('pointerup', end);
        r.addEventListener('pointercancel', end);
        r.addEventListener('keydown', (e) => {
            if (this.locked) return;
            const big = e.key === 'PageUp' || e.key === 'PageDown';
            let d = 0;
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp') d = 1;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown') d = -1;
            if (e.key === 'Home') { this.setPos(0); e.preventDefault(); return; }
            if (e.key === 'End') { this.setPos(1); e.preventDefault(); return; }
            if (!d) return;
            e.preventDefault();
            e.stopPropagation();
            const inc = big ? 0.1 : e.shiftKey ? 0.0005 : 0.01;
            const linear = !this.spec.curve || this.spec.curve === 'lin';
            if (this.spec.step && linear) {
                const range = this.spec.max - this.spec.min;
                this.setValue(this.value + d * Math.max(this.spec.step, inc * range), true);
                return;
            }
            this.setPos(this.pos + d * inc);
        });
    }
}

// --- Labelled parameter controls with lock and reset ---
function paramShell(m, spec, controlEl, displayEl) {
    const label = el('label', { class: 'param-label', text: spec.label });
    const lockBtn = el('button', { class: 'param-lock-button', type: 'button', title: 'Lock', html: lockIcon(false) });
    const header = el('div', { class: 'param-header' }, label, lockBtn);
    const wrap = el('div', { class: 'param-control-wrapper' }, controlEl, displayEl);
    const box = el('div', { class: 'param-container' }, header, wrap);
    let lastTap = 0;
    label.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const now = performance.now();
        if (now - lastTap < DOUBLE_TAP_MS) { lastTap = 0; if (!m.isLocked(spec.key)) m.resetParam(spec.key); }
        else lastTap = now;
    });
    lockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    lockBtn.addEventListener('click', (e) => { e.stopPropagation(); m.setLocked(spec.key, !m.isLocked(spec.key)); });
    return { box, lockBtn, label };
}

export function sliderControl(m, spec) {
    const fmt = spec.format || ((v) => (spec.step >= 1 ? String(Math.round(v)) : v.toFixed(2)));
    const display = el('span', { class: 'param-value-display', title: 'Click to type a value' });
    const slider = new FineSlider(spec, (v) => m.setParam(spec.key, v));
    const { box, lockBtn } = paramShell(m, spec, slider.root, display);
    display.addEventListener('pointerdown', (e) => e.stopPropagation());
    display.addEventListener('click', (e) => {
        e.stopPropagation();
        if (m.isLocked(spec.key)) return;
        const input = el('input', { class: 'param-value-input', type: 'text', inputmode: 'decimal', value: String(+m.params[spec.key].toFixed(4)) });
        display.replaceWith(input);
        input.focus();
        input.select();
        const finish = (apply) => {
            if (apply) {
                const v = parseNumber(input.value, spec);
                if (Number.isFinite(v)) m.setParam(spec.key, quantize(v, spec));
            }
            input.replaceWith(display);
        };
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') finish(true);
            if (ev.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => { if (input.isConnected) finish(true); }, { once: true });
    });
    return {
        el: box,
        set(v) { slider.setValue(v); display.textContent = fmt(v); },
        lock(l) { slider.setLocked(l); lockBtn.innerHTML = lockIcon(l); },
    };
}

function parseNumber(str, spec) {
    const s = String(str).trim().toLowerCase().replace(',', '.');
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return NaN;
    if (spec.parse) return spec.parse(n, s);
    if (/k(hz)?$/.test(s)) return n * 1000;
    if (/ms$/.test(s) && spec.unit === 's') return n / 1000;
    if (/%$/.test(s) && spec.unit === 'ratio') return n / 100;
    return n;
}

export function selectControl(m, spec) {
    const sel = el('select', {}, spec.options.map((o) => el('option', { value: o.value, text: o.label })));
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
        const raw = sel.value;
        const v = typeof spec.default === 'number' ? Number(raw) : raw;
        m.setParam(spec.key, v);
    });
    const { box, lockBtn } = paramShell(m, spec, sel, null);
    return {
        el: box,
        set(v) { sel.value = String(v); },
        lock(l) { sel.disabled = l; sel.classList.toggle('locked-control', l); lockBtn.innerHTML = lockIcon(l); },
    };
}

// --- Pitch control: free (coarse + fine) or note (note + octave), fine applies to both ---
export function pitchControl(m, opts) {
    const { min, max } = opts;
    const readout = el('span', { class: 'pitch-readout' });
    const toggle = el('button', { class: 'pitch-mode-toggle', type: 'button' });
    const free = el('div');
    const note = el('div', { class: 'note-pitch-controls' });
    const group = el('div', { class: 'pitch-control-group' },
        el('div', { class: 'pitch-top' }, readout, toggle), free, note);

    const coarse = sliderControl(m, { key: 'freq', label: opts.label || 'Freq', min, max, curve: 'log', default: m.def.params.freq.default, format: formatFrequency, unit: 'Hz' });
    free.append(coarse.el);
    const fineSpec = { key: 'fine', label: 'Fine Tune', min: -1, max: 1, default: 0 };
    const fine = sliderControl(m, { ...fineSpec, format: (v) => `${(v * settings.fineTuneRange).toFixed(2)}%` });
    const noteSel = selectControl(m, { key: 'note', label: 'Note', default: 'A', options: NOTE_NAMES.map((n) => ({ value: n, label: n })) });
    const octOpts = [];
    for (let o = opts.minOctave; o <= opts.maxOctave; o++) octOpts.push({ value: o, label: String(o) });
    const octSel = selectControl(m, { key: 'octave', label: 'Octave', default: 4, options: octOpts });
    note.append(noteSel.el, octSel.el);
    group.append(fine.el);

    toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const toNote = m.params.mode !== 'note';
        if (toNote) {
            // Snap note selects to the nearest note of the current frequency.
            const n = nearestNote(clamp(m.params.freq, min, max));
            if (!m.isLocked('note')) m.setParam('note', n.name, false);
            if (!m.isLocked('octave')) m.setParam('octave', clamp(n.octave, opts.minOctave, opts.maxOctave), false);
        } else if (!m.isLocked('freq')) {
            m.setParam('freq', clamp(midiToFreq(noteToMidi(m.params.note, m.params.octave)), min, max), false);
        }
        m.setParam('mode', toNote ? 'note' : 'free');
    });

    const api = {
        el: group,
        controls: { freq: coarse, fine, note: noteSel, octave: octSel },
        refresh() {
            const isNote = m.params.mode === 'note';
            toggle.textContent = isNote ? 'Free Mode' : 'Note Mode';
            free.classList.toggle('hidden', isNote);
            note.classList.toggle('hidden', !isNote);
            const f = api.frequency();
            const n = nearestNote(Math.max(f, 0.0001));
            readout.textContent = `${formatFrequency(f)} · ${n.name}${n.octave}`;
            fine.set(m.params.fine);
        },
        frequency() {
            const base = m.params.mode === 'note' ? midiToFreq(noteToMidi(m.params.note, m.params.octave)) : m.params.freq;
            return clamp(base * (1 + m.params.fine * settings.fineTuneRange / 100), min * 0.5, max * 2);
        },
    };
    return api;
}
